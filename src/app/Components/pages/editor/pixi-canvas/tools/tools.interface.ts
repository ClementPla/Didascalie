import { Renderer } from 'pixi.js';
import { DrawingLayer } from '../core/drawing-layer';
import { DrawingOptions } from '../core/drawing-controller';
import { Tools } from '../../../../../Core/tools';

/**
 * Interface for drawing tools
 * Each tool implements specific drawing behavior
 */
export interface ITool {
  /**
   * Called when drawing starts (mouse down)
   */
  onStart(
    point: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void;

  /**
   * Called during drawing (mouse move)
   */
  onMove(
    previousPoint: { x: number; y: number },
    currentPoint: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void;

  /**
   * Called when drawing ends (mouse up)
   */
  onEnd(
    point: { x: number; y: number },
    strokePoints: { x: number; y: number }[],
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): Promise<void> | void;

  /**
   * Optional: Called when drawing is cancelled (ESC key)
   */
  onCancel?(): void;

  /**
   * Get the tool identifier from your Tools class
   */
  getToolId(): number;
}

/**
 * Pen tool - draws smooth strokes
 * Corresponds to Tools.PEN (id: 1)
 */
export class PenTool implements ITool {
  getToolId(): number {
    return Tools.PEN.id;
  }

  onStart(
    point: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    // Draw initial dot
    layer.drawDot(point.x, point.y, options.lineWidth / 2, renderer);
  }

  onMove(
    previousPoint: { x: number; y: number },
    currentPoint: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    layer.drawStroke(
      previousPoint.x,
      previousPoint.y,
      currentPoint.x,
      currentPoint.y,
      options.lineWidth,
      renderer
    );
  }

  onEnd(): void {
    // Nothing special to do
  }
}

/**
 * Eraser tool - removes strokes
 * Corresponds to Tools.ERASER (id: 8)
 *
 * Note: This erases from the active layer only.
 * For erasing from all layers (eraseAll mode), handle in the controller.
 */
export class EraserTool implements ITool {
  getToolId(): number {
    return Tools.ERASER.id;
  }

  onStart(
    point: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    // Erase initial dot by drawing a small circle area
    const offset = 0.5;
    layer.eraseStroke(
      point.x - offset,
      point.y - offset,
      point.x + offset,
      point.y + offset,
      options.lineWidth,
      renderer
    );
  }

  onMove(
    previousPoint: { x: number; y: number },
    currentPoint: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    layer.eraseStroke(
      previousPoint.x,
      previousPoint.y,
      currentPoint.x,
      currentPoint.y,
      options.lineWidth,
      renderer
    );
  }

  onEnd(): void {
    // Nothing special to do
  }
}

/**
 * Lasso tool - draws filled polygons
 * Corresponds to Tools.LASSO (id: 2)
 */
export class LassoTool implements ITool {
  private lassoPoints: { x: number; y: number }[] = [];

  getToolId(): number {
    return Tools.LASSO.id;
  }

  onStart(
    point: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    this.lassoPoints = [point];
  }

  onMove(
    previousPoint: { x: number; y: number },
    currentPoint: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    this.lassoPoints.push(currentPoint);
  }

  onEnd(
    point: { x: number; y: number },
    strokePoints: { x: number; y: number }[],
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    if (this.lassoPoints.length >= 3) {
      layer.drawPolygon(this.lassoPoints, renderer);
    }
    this.lassoPoints = [];
  }

  onCancel(): void {
    this.lassoPoints = [];
  }
}

/**
 * Lasso eraser tool - erases polygon areas
 * Corresponds to Tools.LASSO_ERASER (id: 3)
 */
export class LassoEraserTool implements ITool {
  private lassoPoints: { x: number; y: number }[] = [];

  getToolId(): number {
    return Tools.LASSO_ERASER.id;
  }

  onStart(
    point: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    this.lassoPoints = [point];
  }

  onMove(
    previousPoint: { x: number; y: number },
    currentPoint: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    this.lassoPoints.push(currentPoint);
  }

  onEnd(
    point: { x: number; y: number },
    strokePoints: { x: number; y: number }[],
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    if (this.lassoPoints.length >= 3) {
      layer.erasePolygon(this.lassoPoints, renderer);
    }
    this.lassoPoints = [];
  }

  onCancel(): void {
    this.lassoPoints = [];
  }
}

/**
 * Line tool - draws straight lines
 * Corresponds to Tools.LINE (id: 4)
 */
export class LineTool implements ITool {
  private startPoint: { x: number; y: number } | null = null;

  getToolId(): number {
    return Tools.LINE.id;
  }

  onStart(
    point: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    this.startPoint = point;
    // Draw initial dot
    layer.drawDot(point.x, point.y, options.lineWidth / 2, renderer);
  }

  onMove(
    previousPoint: { x: number; y: number },
    currentPoint: { x: number; y: number },
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    // Don't draw during move - only show preview in UI
  }

  onEnd(
    point: { x: number; y: number },
    strokePoints: { x: number; y: number }[],
    layer: DrawingLayer,
    renderer: Renderer,
    options: DrawingOptions
  ): void {
    if (this.startPoint) {
      layer.drawStroke(
        this.startPoint.x,
        this.startPoint.y,
        point.x,
        point.y,
        options.lineWidth,
        renderer
      );
    }
    this.startPoint = null;
  }

  onCancel(): void {
    this.startPoint = null;
  }
}

/**
 * Tool registry - maps Tool instances to ITool implementations
 */
export class ToolRegistry {
  private static toolMap = new Map<number, ITool>([
    [Tools.PEN.id, new PenTool()],
    [Tools.ERASER.id, new EraserTool()],
    [Tools.LASSO.id, new LassoTool()],
    [Tools.LASSO_ERASER.id, new LassoEraserTool()],
    [Tools.LINE.id, new LineTool()],
  ]);

  /**
   * Get ITool implementation from your Tool class instance
   */
  static getTool(tool: { id: number }): ITool | undefined {
    return this.toolMap.get(tool.id);
  }

  /**
   * Check if a tool is a drawing tool
   */
  static isDrawingTool(toolId: number): boolean {
    return (
      toolId === Tools.PEN.id ||
      toolId === Tools.LASSO.id ||
      toolId === Tools.LINE.id
    );
  }

  /**
   * Check if a tool is an eraser tool
   */
  static isEraserTool(toolId: number): boolean {
    return toolId === Tools.ERASER.id || toolId === Tools.LASSO_ERASER.id;
  }

  /**
   * Check if a tool uses brush size
   */
  static isToolWithBrushSize(toolId: number): boolean {
    return (
      toolId === Tools.PEN.id ||
      toolId === Tools.ERASER.id ||
      toolId === Tools.LINE.id
    );
  }
}
