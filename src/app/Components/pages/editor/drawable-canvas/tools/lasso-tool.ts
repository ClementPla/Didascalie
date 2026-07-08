import { BaseTool } from './base-tool';
import { ToolContext } from '../interface';
import { Point2D } from '../interface';

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
    const points =  context.getCoords(event)
    this.points.push(points);

    context.updatePreviewPoints(this.points);
  }

  async end(context: ToolContext) {
    if (this.points.length < 3) {
      this.points = [];
      return;
    }

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

    if (!context.editorService.penPostProcess) {
       if (context.editorService.swapMarkers) {
         context.swapMarkers();
       } else {
         this.commitBufferToActive(context);
       }
    }
  }

  private handleLassoEraser(context: ToolContext) {
    // Draw the lasso shape onto the buffer as the erase mask.
    const ctxBuffer = context.canvasManager.getBufferCtx();
    this.fillShape(ctxBuffer, context.color);

    // With eraserPostProcess the connected-component erase runs later in
    // DrawService; here we just leave the shape on the buffer.
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