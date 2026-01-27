import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

// Services
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { ProjectService } from '../../../../../Services/ProjectService/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { StateManagerService } from './state-manager.service';
import { CanvasManagerService } from './canvas-manager.service';
import { UndoRedoService } from './undo-redo.service';
import { PostProcessService } from './post-process.service';
import { OpenCVService } from '../../../../../Services/open-cv.service';

// Models & Tools
import { Tools } from '../../../../../Core/tools';
import { BboxLabel } from '../../../../../Core/interface';
import { Point2D, DrawingTool, ToolContext } from '../interface';
import {
  PenTool,
  EraserTool,
  LassoTool,
  LineTool,
  LassoEraserTool,
} from '../tools';
import { IOService } from '../../../../../Services/io.service';

@Injectable({
  providedIn: 'root',
})
export class DrawService implements OnDestroy {
  // Public streams for UI updates
  public redrawRequest = new Subject<boolean>();
  public singleDrawRequest = new Subject<OffscreenCanvasRenderingContext2D | null>();
  public previewPoints$ = new BehaviorSubject<Point2D[]>([]);

  // Strategy Map
  private tools = new Map<Tools, DrawingTool>([
    [Tools.PEN, new PenTool()],
    [Tools.ERASER, new EraserTool()],
    [Tools.LINE, new LineTool()],
    [Tools.LASSO, new LassoTool()],
    [Tools.LASSO_ERASER, new LassoEraserTool()],
  ]);

  // Cached context for current stroke - created once per stroke, not per event
  private currentToolContext: ToolContext | null = null;

  private destroy$ = new Subject<void>();

  constructor(
    private labelService: LabelsService,
    private projectService: ProjectService,
    private zoomPanService: ZoomPanService,
    private editorService: EditorService,
    private stateService: StateManagerService,
    private canvasManagerService: CanvasManagerService,
    private undoRedoService: UndoRedoService,
    private postProcessService: PostProcessService,
    private openCVService: OpenCVService,
    private ioService: IOService
  ) {
    this.initializeSubscriptions();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ==========================================
  // Core Lifecycle (Delegation to Tools)
  // ==========================================

  public startDraw(event: MouseEvent): void {
    this.stateService.reset();
    this.stateService.isDrawing = true;

    // Initialize the points
    const coords = this.zoomPanService.getImageCoordinates(event);
    this.stateService.updateCurrentPoint(coords);
    this.stateService.updatePreviousPoint(coords);

    // Clear buffer to prepare for new stroke
    this.clearCanvas(this.canvasManagerService.bufferCtx);

    // Create tool context once for the entire stroke
    this.currentToolContext = this.createToolContext();

    const tool = this.tools.get(this.editorService.selectedTool);
    if (tool) {
      tool.start(event, this.currentToolContext);
    }
  }

  public draw(event: MouseEvent): void {
    if (!this.stateService.isDrawing || !this.labelService.activeLabel) {
      return;
    }

    const tool = this.tools.get(this.editorService.selectedTool);
    if (!tool || !this.currentToolContext) return;

    // Update global state tracking (Min/Max points for bbox)
    const imageCoord = this.zoomPanService.getImageCoordinates(event);
    this.stateService.updatePreviousPoint(this.stateService.currentPoint);
    this.stateService.updateCurrentPoint(imageCoord);
    this.stateService.updateMinMaxPoints(imageCoord);

    if (this.editorService.isEraser()) {
      this.stateService.recomputeCanvasSum = true;
    }

    // Update context's dynamic properties
    this.currentToolContext.color = this.getFillColor();

    // Delegate drawing logic to tool
    tool.draw(event, this.currentToolContext);
  }

  public async endDraw(event: MouseEvent): Promise<void> {
    if (!this.stateService.isDrawing) return;

    // Final update for the release point
    const imageCoord = this.zoomPanService.getImageCoordinates(event);
    this.stateService.updateCurrentPoint(imageCoord);

    const tool = this.tools.get(this.editorService.selectedTool);
    if (tool && this.currentToolContext) {
      await tool.end(this.currentToolContext);
    }

    this.stateService.isDrawing = false;
    this.currentToolContext = null; // Clear cached context

    // Global Post-Processing (Service Level)
    await this.handleGlobalPostProcessing();
    this.stateService.recomputeCanvasSum = true;
    this.ioService.markDirty();
    // Finalize
    this.redrawRequest.next(true);

    if (
      this.projectService.isInstanceSegmentation() &&
      this.editorService.incrementAfterStroke
    ) {
      this.labelService.incrementActiveInstance();
    }

    await this.undoRedoService.updateUndoRedo();
  }


  // ==========================================
  // Context Helper
  // ==========================================

  /**
   * Creates the tool context. Called once per stroke in startDraw().
   */
  private createToolContext(): ToolContext {
    return {
      canvasManager: this.canvasManagerService,
      stateService: this.stateService,
      editorService: this.editorService,
      color: this.getFillColor(),
      getCoords: (e) => this.zoomPanService.getImageCoordinates(e),
      // Provide swap function directly instead of circular reference
      swapMarkers: () => this.swapMarkers(),
      singleDrawRequest: (ctx) => this.singleDrawRequest.next(ctx),
      redrawRequest: () => this.redrawRequest.next(true),
      updatePreviewPoints: (points: Point2D[]) => this.previewPoints$.next(points),
    };
  }

  // ==========================================
  // Shared Actions / Utilities
  // ==========================================

  /**
   * Swaps markers between active label and others.
   * Note: This temporarily modifies edgesOnly state for computation.
   */
  public swapMarkers(): void {
    const activeIndex = this.labelService.getActiveIndex();
    const ctx = this.canvasManagerService.getBufferCtx();
    const bufferCanvas = this.canvasManagerService.getBufferCanvas();
    ctx.fillStyle = this.getFillColor();

    const rect = this.stateService.getBoundingBox();
    ctx.globalCompositeOperation = 'source-in';
    this.stateService.recomputeCanvasSum = true;

    // Compute combined canvas without edges for swap calculation
    const combinedCanvas = this.computeCombinedCanvasWithoutEdges();

    ctx.drawImage(
      combinedCanvas,
      rect.x, rect.y, rect.width, rect.height,
      rect.x, rect.y, rect.width, rect.height
    );

    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.globalCompositeOperation = 'source-over';

    // Remove the overlapped shape from other class canvases
    this.canvasManagerService.getAllCanvasCtx().forEach((classCtx, index) => {
      classCtx.globalCompositeOperation = index === activeIndex
        ? 'source-over'
        : 'destination-out';

      classCtx.drawImage(
        bufferCanvas,
        rect.x, rect.y, rect.width, rect.height,
        rect.x, rect.y, rect.width, rect.height
      );
      classCtx.globalCompositeOperation = 'source-over';
    });

    this.stateService.recomputeCanvasSum = true;
  }

  /**
   * Computes combined canvas without edges effect.
   * Isolates the edgesOnly state mutation to a single method.
   */
  private computeCombinedCanvasWithoutEdges(): OffscreenCanvas {
    const edgesOnly = this.editorService.edgesOnly;

    if (edgesOnly) {
      this.editorService.edgesOnly = false;
      this.canvasManagerService.computeCombinedCanvas();
      this.editorService.edgesOnly = edgesOnly;
    } else {
      this.canvasManagerService.computeCombinedCanvas();
    }

    return this.canvasManagerService.getCombinedCanvas();
  }

  private async handleGlobalPostProcessing(): Promise<void> {
    if (this.editorService.penPostProcess && this.editorService.isDrawingTool()) {
      this.stateService.recomputeCanvasSum = true;
      await this.postProcessService.getPostProcessFunction();
    } else if (this.editorService.eraserPostProcess && this.editorService.isEraser()) {
      await this.postProcessService.eraseAll_post_process();
    }
  }

  /**
   * Gets the fill color for the current label/instance.
   * Returns a fallback color if no active label is set.
   */
  public getFillColor(): string {
    if (this.projectService.isInstanceSegmentation()) {
      return this.labelService.activeSegInstance?.shade ?? '#ffffff';
    }
    return this.labelService.activeLabel?.color ?? '#ffffff';
  }

  public clearCanvas(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ): void {
    ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  /**
   * Refreshes the color of a canvas layer.
   * @param inputCtx - Optional specific context to refresh. Uses active context if not provided.
   * @param inputColor - Optional color override. Uses active label color if not provided.
   */
  public refreshColor(
    inputCtx: OffscreenCanvasRenderingContext2D | null = null,
    inputColor: string | null = null
  ): void {
    if (this.projectService.isInstanceSegmentation()) {
      this.redrawRequest.next(true);
      return;
    }

    const ctx = inputCtx ?? this.canvasManagerService.getActiveCtx();
    if (!ctx) return;

    const color = inputColor ?? this.labelService.activeLabel?.color ?? '#ffffff';

    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillRect(0, 0, this.stateService.width, this.stateService.height);
    ctx.globalCompositeOperation = 'source-over';

    this.redrawRequest.next(true);
  }

  public refreshAllColors(): void {
    this.canvasManagerService.getAllCanvasCtx().forEach((ctx, index) => {
      const label = this.labelService.listSegmentationLabels[index];
      if (label) {
        this.refreshColor(ctx, label.color);
      }
    });
  }

  public wheel(event: WheelEvent): void {
    if (event.ctrlKey) {
      const delta = event.deltaY > 0 ? -2 : 2;
      this.editorService.lineWidth += delta;
    } else {
      this.zoomPanService.wheel(event);
    }
  }

  private initializeSubscriptions(): void {
    this.editorService.canvasSumRefresh
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.canvasManagerService.computeCombinedCanvas();
        this.redrawRequest.next(true);
      });

    this.editorService.canvasRedraw
      .pipe(takeUntil(this.destroy$))
      .subscribe((value) => {
        if (value) {
          this.stateService.recomputeCanvasSum = value;
          this.refreshColor();
        }
      });

    this.editorService.canvasClear
      .pipe(takeUntil(this.destroy$))
      .subscribe((value) => {
        if (value >= 0) {
          this.stateService.recomputeCanvasSum = true;
          this.canvasManagerService.clearCanvasAtIndex(value);
          this.ioService.markDirty();
          this.redrawRequest.next(true);
        }
      });
  }

  /**
   * Erases a connected component by bounding box click.
   * This is an action utility, not a drawing tool.
   */
  public eraseOnBboxClick(bbox: BboxLabel): void {
    const id = bbox.instance;
    const isCombined = this.editorService.labelledCombinedBoundingBox;

    // Get the source canvas for mask detection
    const sourceCtx = isCombined
      ? this.getCombinedCtxWithoutEdges()
      : null;

    this.canvasManagerService.getAllCanvasCtx().forEach((ctx, index) => {
      // Skip non-matching labels when not using combined mode
      if (!isCombined) {
        const label = this.labelService.listSegmentationLabels[index];
        if (label?.label !== bbox.label.label) return;
      }

      const maskSource = isCombined ? sourceCtx! : ctx;
      const maskCanvas = this.openCVService.getMaskOfConnectedComponentsById(
        maskSource,
        id
      );

      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(
        maskCanvas,
        bbox.bbox.x, bbox.bbox.y, bbox.bbox.width, bbox.bbox.height,
        bbox.bbox.x, bbox.bbox.y, bbox.bbox.width, bbox.bbox.height
      );
      ctx.globalCompositeOperation = 'source-over';
    });

    this.stateService.recomputeCanvasSum = true;
    this.ioService.markDirty();
    this.redrawRequest.next(true);
  }

  /**
   * Gets combined context, temporarily disabling edges if needed.
   */
  private getCombinedCtxWithoutEdges(): OffscreenCanvasRenderingContext2D {
    if (this.editorService.edgesOnly) {
      this.editorService.edgesOnly = false;
      this.canvasManagerService.computeCombinedCanvas();
      this.editorService.edgesOnly = true;
    }
    return this.canvasManagerService.getCombinedCtx();
  }
}