import { BaseTool } from './base-tool';
import { ToolContext } from '../interface';
import { Point2D } from '../interface';
import { smoothPath } from './stroke-smoothing';

export class LassoTool extends BaseTool {
  protected points: Point2D[] = [];
  private isEraser: boolean;

  constructor(isEraser = false) {
    super();
    this.isEraser = isEraser;
  }

  start(event: MouseEvent, context: ToolContext) {
    this.points = [context.getCoords(event)];
  }

  draw(event: MouseEvent, context: ToolContext) {
    this.points.push(context.getCoords(event));
    // Smoothed as an open path, so the preview ends under the pointer.
    context.updatePreviewPoints(this.smoothed(context, false));
  }

  /** The outline with `lassoSmoothing` applied, or the raw points when off. */
  protected smoothed(context: ToolContext, closed: boolean): Point2D[] {
    const scale = context.imagePxPerScreenPx();
    const radius = context.editorService.lassoSmoothing * scale;
    // One sample every 2 screen pixels: finer than the eye, cheap per move.
    return smoothPath(this.points, radius, 2 * scale, closed);
  }

  async end(context: ToolContext) {
    if (this.points.length < 3) {
      this.points = [];
      return;
    }

    this.points = this.smoothed(context, true);
    if (this.isEraser) {
      this.handleLassoEraser(context);
    } else {
      this.handleLassoDraw(context);
    }
    
    this.points = [];
    context.updatePreviewPoints([]); // Clear the preview
  }

  private handleLassoDraw(context: ToolContext) {
    const ctx = context.canvasManager.getBufferCtx();
    this.fillShape(ctx, context.color); // Fill buffer

    if (!context.editorService.penPostProcess) this.commitDrawStroke(context);
  }

  private handleLassoEraser(context: ToolContext) {
    const ctxBuffer = context.canvasManager.getBufferCtx();
    this.fillShape(ctxBuffer, context.color);

    // With `eraserPostProcess`, DrawService erases the touched components.
    if (context.editorService.eraserPostProcess) return;

    this.eraseBufferFromTargets(context);
  }

  protected fillShape(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, color: string) {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 0;
    ctx.globalCompositeOperation = 'source-over';
    
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    ctx.closePath();
    ctx.fill();
  }
}