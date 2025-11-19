import { Point, Renderer } from 'pixi.js';
import { LayerManager } from './layer-manager';
import { UndoRedoManager } from './undo-redo-manager';
import { ITool } from '../tools/tools.interface';
import { EditorService } from '../../../../../Services/UI/editor.service';

export interface DrawingOptions {
  lineWidth: number;
  binarizeAfterStroke: boolean;
  binarizeThreshold: number;
}

/**
 * Main drawing controller - orchestrates drawing operations
 */
export class DrawingController {
  private isDrawing = false;
  private previousPoint: { x: number; y: number } | null = null;
  private currentStrokePoints: { x: number; y: number }[] = [];
  private activeTool: ITool | null = null;

  public options: DrawingOptions = {
    lineWidth: 5,
    binarizeAfterStroke: true,
    binarizeThreshold: 127,
  };

  constructor(
    private layerManager: LayerManager,
    private undoRedoManager: UndoRedoManager,
    private renderer: Renderer,
    private editorService?: EditorService
  ) {}

  /**
   * Set the active drawing tool
   */
  public setTool(tool: ITool): void {
    this.activeTool = tool;
  }

  /**
   * Start drawing (mouse down)
   */
  public startDraw(worldPoint: { x: number; y: number }): void {
    const activeLayer = this.layerManager.getActiveLayer();
    if (!activeLayer) return;

    // Save state for undo
    this.saveUndoState();

    this.isDrawing = true;
    this.previousPoint = worldPoint;
    this.currentStrokePoints = [worldPoint];

    // Initialize tool
    if (this.activeTool) {
      this.activeTool.onStart(
        worldPoint,
        activeLayer,
        this.renderer,
        this.options
      );
    } else {
      // Default: draw initial dot
      activeLayer.drawDot(
        worldPoint.x,
        worldPoint.y,
        this.options.lineWidth / 2,
        this.renderer
      );
    }
  }

  /**
   * Continue drawing (mouse move)
   */
  public draw(worldPoint: { x: number; y: number }): void {
    if (!this.isDrawing || !this.previousPoint) return;

    const activeLayer = this.layerManager.getActiveLayer();
    if (!activeLayer) return;

    this.currentStrokePoints.push(worldPoint);

    if (this.activeTool) {
      this.activeTool.onMove(
        this.previousPoint,
        worldPoint,
        activeLayer,
        this.renderer,
        this.options
      );
    } else {
      // Default: draw line segment
      this.drawDefaultStroke(activeLayer, this.previousPoint, worldPoint);
    }

    this.previousPoint = worldPoint;
  }

  /**
   * End drawing (mouse up)
   */
  public async endDraw(worldPoint: { x: number; y: number }): Promise<void> {
    if (!this.isDrawing) return;

    const activeLayer = this.layerManager.getActiveLayer();
    if (!activeLayer) return;

    if (this.activeTool) {
      await this.activeTool.onEnd(
        worldPoint,
        this.currentStrokePoints,
        activeLayer,
        this.renderer,
        this.options
      );
    }

    // Binarize if enabled
    if (this.options.binarizeAfterStroke) {
      activeLayer.binarize(this.renderer, this.options.binarizeThreshold);
    }

    this.isDrawing = false;
    this.previousPoint = null;
    this.currentStrokePoints = [];
  }

  /**
   * Default stroke drawing (pen tool)
   */
  private drawDefaultStroke(
    layer: any,
    from: { x: number; y: number },
    to: { x: number; y: number }
  ): void {
    layer.drawStroke(
      from.x,
      from.y,
      to.x,
      to.y,
      this.options.lineWidth,
      this.renderer
    );
  }

  /**
   * Cancel current drawing operation
   */
  public cancelDraw(): void {
    this.isDrawing = false;
    this.previousPoint = null;
    this.currentStrokePoints = [];

    if (this.activeTool) {
      this.activeTool.onCancel?.();
    }
  }

  /**
   * Undo last action
   */
  public undo(): void {
    const currentStates = this.layerManager.getAllLayerStates();
    const previousStates = this.undoRedoManager.undo(currentStates);

    if (previousStates) {
      this.layerManager.setAllLayerStates(previousStates);
    }
  }

  /**
   * Redo last undone action
   */
  public redo(): void {
    const currentStates = this.layerManager.getAllLayerStates();
    const nextStates = this.undoRedoManager.redo(currentStates);

    if (nextStates) {
      this.layerManager.setAllLayerStates(nextStates);
    }
  }

  /**
   * Save current state to undo stack
   */
  private saveUndoState(): void {
    const currentStates = this.layerManager.getAllLayerStates();
    this.undoRedoManager.saveState(currentStates);
  }

  /**
   * Check if currently drawing
   */
  public getIsDrawing(): boolean {
    return this.isDrawing;
  }

  /**
   * Check if undo is available
   */
  public canUndo(): boolean {
    return this.undoRedoManager.canUndo();
  }

  /**
   * Check if redo is available
   */
  public canRedo(): boolean {
    return this.undoRedoManager.canRedo();
  }

  /**
   * Get current stroke points (for preview)
   */
  public getCurrentStrokePoints(): { x: number; y: number }[] {
    return [...this.currentStrokePoints];
  }
}
