import {
  AfterViewInit,
  Component,
  ElementRef,
  ViewChild,
  OnDestroy,
} from '@angular/core';
import { Application, Sprite, Container, Assets, Point } from 'pixi.js';
import { PixiZoomPanController } from './utils/pixi-zoom-pan-container';
import { LayerManager } from './core/layer-manager';
import { DrawingController } from './core/drawing-controller';
import { UndoRedoManager } from './core/undo-redo-manager';
import { PixiServiceAdapter } from './pixi-service-adapter';
import { EditorService } from '../services/editor.service';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { ProjectService } from '../../../../Services/ProjectService/project.service';
import { Tools } from '../../../../Core/tools';
import { Subject, Subscription } from 'rxjs';

@Component({
  selector: 'app-pixi-canvas',
  imports: [],
  templateUrl: './pixi-canvas.component.html',
  styleUrl: './pixi-canvas.component.scss',
})
export class PixiCanvasComponent implements AfterViewInit, OnDestroy {
  @ViewChild('pixiContainer', { static: true })
  pixiContainer!: ElementRef<HTMLDivElement>;

  private app!: Application;
  private backgroundSprite!: Sprite;
  private viewport!: Container;

  // Core managers
  private zoomPanController!: PixiZoomPanController;
  private layerManager!: LayerManager;
  private drawingController!: DrawingController;
  private undoRedoManager!: UndoRedoManager;
  private serviceAdapter!: PixiServiceAdapter;

  // Service subscriptions
  private subscriptions = new Subscription();

  // Public subjects for compatibility with old DrawableCanvasComponent
  public redrawRequest = new Subject<boolean>();

  constructor(
    private editorService: EditorService,
    private labelsService: LabelsService,
    private projectService: ProjectService
  ) {}

  async ngAfterViewInit(): Promise<void> {
    await this.initializePixiApp();
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    if (this.serviceAdapter) {
      this.serviceAdapter.destroy();
    }
    if (this.app) {
      this.app.destroy(true);
    }
  }

  /**
   * Initialize PixiJS application
   */
  private async initializePixiApp(): Promise<void> {
    this.app = new Application();
    await this.app.init({
      background: '#0b2830ff',
      width: this.pixiContainer.nativeElement.clientWidth,
      height: this.pixiContainer.nativeElement.clientHeight,
      antialias: false,
      resolution: 1,
      autoDensity: false,
    });
    this.pixiContainer.nativeElement.appendChild(this.app.canvas);

    // Create viewport container for zoom/pan
    this.viewport = new Container();
    this.app.stage.addChild(this.viewport);

    this.zoomPanController = new PixiZoomPanController(this.viewport);

    // Handle window resize manually
    this.setupResizeHandler();
  }

  /**
   * Setup manual resize handler
   */
  private setupResizeHandler(): void {
    const resizeObserver = new ResizeObserver(() => {
      const width = this.pixiContainer.nativeElement.clientWidth;
      const height = this.pixiContainer.nativeElement.clientHeight;

      if (width > 0 && height > 0) {
        this.app.renderer.resize(width, height);
      }
    });

    resizeObserver.observe(this.pixiContainer.nativeElement);

    // Store for cleanup
    this.subscriptions.add(() => resizeObserver.disconnect());
  }

  /**
   * Load background image and setup layers
   * This replaces your old loadImage method
   */
  public async loadImage(imageUrl: string): Promise<void> {
    const texture = await Assets.load(imageUrl);
    texture.source.scaleMode = 'nearest';

    // Remove old background if exists
    if (this.backgroundSprite) {
      this.viewport.removeChild(this.backgroundSprite);
      this.backgroundSprite.destroy();
    }

    this.backgroundSprite = new Sprite(texture);
    this.backgroundSprite.roundPixels = true;
    this.viewport.addChildAt(this.backgroundSprite, 0);

    // Fit to screen using improved method
    // this.zoomPanController.fitToScreen(
    //   this.backgroundSprite.width,
    //   this.backgroundSprite.height,
    //   this.pixiContainer.nativeElement.clientWidth,
    //   this.pixiContainer.nativeElement.clientHeight
    // );

    // Setup or recreate layers
    this.setupLayers();
  }

  /**
   * Setup drawing layers based on labels
   */
  private setupLayers(): void {
    const width = this.backgroundSprite.width;
    const height = this.backgroundSprite.height;

    // Destroy old managers if they exist
    if (this.layerManager) {
      this.layerManager.destroy();
    }

    // Initialize managers
    this.undoRedoManager = new UndoRedoManager(50);
    this.layerManager = new LayerManager(
      this.viewport,
      this.app.renderer,
      width,
      height
    );
    this.drawingController = new DrawingController(
      this.layerManager,
      this.undoRedoManager,
      this.app.renderer,
      this.editorService
    );

    // Create service adapter
    if (this.serviceAdapter) {
      this.serviceAdapter.destroy();
    }
    this.serviceAdapter = new PixiServiceAdapter(
      this.drawingController,
      this.layerManager,
      this.editorService,
      this.labelsService,
      this.projectService
    );

    // This will create layers based on labelsService.listSegmentationLabels
    this.serviceAdapter.syncLayersFromLabels();

    // Setup service watchers
    this.setupServiceWatchers();
  }

  /**
   * Watch for changes in services and sync
   */
  private setupServiceWatchers(): void {
    // Watch for line width changes
    this.subscriptions.add(
      this.editorService.canvasRedraw.subscribe(() => {
        this.serviceAdapter.syncLineWidth();
        this.redrawRequest.next(true);
      })
    );
  }

  /**
   * Redraw all canvas layers (compatibility method)
   */
  public redrawAllCanvas(): void {
    // PixiJS automatically redraws, but we can trigger updates if needed
    this.serviceAdapter.syncLayerVisibility();
    this.redrawRequest.next(true);
  }

  /**
   * Mouse wheel - zoom or adjust line width
   */
  wheel(e: WheelEvent): void {
    if (e.ctrlKey) {
      // Adjust line width with ctrl+wheel
      const delta = e.deltaY > 0 ? -2 : 2;
      this.editorService.lineWidth = Math.max(
        1,
        this.editorService.lineWidth + delta
      );
      this.serviceAdapter.syncLineWidth();
      e.preventDefault();
    } else {
      // Zoom
      this.zoomPanController.wheel(e);
    }
  }

  /**
   * Mouse down - start drawing or panning
   */
  mousedown(e: MouseEvent): void {
    // Check if we should pan (using your Tool class)
    if (e.ctrlKey || this.editorService.selectedTool.id === Tools.PAN.id) {
      this.zoomPanController.startDrag(e);
      return;
    }

    // Check if we have an active label
    if (!this.labelsService.activeLabel) {
      console.warn('No active label selected');
      return;
    }

    // Sync tool and active layer before drawing
    this.serviceAdapter.syncTool();
    this.serviceAdapter.syncActiveLayer();

    // Start drawing
    const worldPoint = this.screenToWorld(e);
    this.drawingController.startDraw(worldPoint);
  }

  /**
   * Mouse up - end drawing or panning
   */
  mouseup(e: MouseEvent): void {
    this.zoomPanController.endDrag();

    if (this.drawingController.getIsDrawing()) {
      const worldPoint = this.screenToWorld(e);
      this.drawingController.endDraw(worldPoint);

      // Trigger redraw request for other components
      this.redrawRequest.next(true);
    }
  }

  /**
   * Mouse move - continue drawing or panning
   */
  mousemove(e: MouseEvent): void {
    if (this.drawingController.getIsDrawing()) {
      const worldPoint = this.screenToWorld(e);
      this.drawingController.draw(worldPoint);
    }
    this.zoomPanController.drag(e);
  }

  /**
   * Convert screen coordinates to world (stage) coordinates
   */
  private screenToWorld(event: MouseEvent): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();

    // Convert client coordinates to canvas coordinates
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;

    // Create a point in canvas space and convert to world space using viewport
    const world = this.viewport.toLocal(
      new Point(canvasX, canvasY),
      this.app.stage
    );

    return { x: world.x, y: world.y };
  }

  /**
   * Public API: Get layer manager (for advanced operations)
   */
  public getLayerManager(): LayerManager {
    return this.layerManager;
  }

  /**
   * Public API: Get drawing controller (for advanced operations)
   */
  public getDrawingController(): DrawingController {
    return this.drawingController;
  }

  /**
   * Public API: Get service adapter (for manual sync)
   */
  public getServiceAdapter(): PixiServiceAdapter {
    return this.serviceAdapter;
  }

  /**
   * Public API: Get zoom/pan controller
   */
  public getZoomPanController(): PixiZoomPanController {
    return this.zoomPanController;
  }

  /**
   * Compatibility: Get all layer states for saving
   */
  public getAllLayerStates(): Map<string, ImageData> {
    return this.layerManager.getAllLayerStates();
  }

  /**
   * Compatibility: Restore all layer states from loading
   */
  public setAllLayerStates(states: Map<string, ImageData>): void {
    this.layerManager.setAllLayerStates(states);
  }
}
