import { BaseTool } from './base-tool';
import { ToolContext, Point2D } from '../interface';

// line-tool.ts
export class LineTool extends BaseTool {
  private startPoint: Point2D | null = null;

  start(event: MouseEvent, context: ToolContext) {
    this.startPoint = context.getCoords(event);
    context.updatePreviewPoints([this.startPoint]);
  }

  draw(event: MouseEvent, context: ToolContext) {
    if (!this.startPoint) return;
    const currentPoint = context.getCoords(event);
    // Preview: Start to Current
    context.updatePreviewPoints([this.startPoint, currentPoint]);
  }

  async end(context: ToolContext) { // Pass event here
    if (!this.startPoint) return;

    // FIX: Get coordinates directly from the end event
    const endPoint = context.stateService.currentPoint;
    const ctx = context.canvasManager.getBufferCtx();
    
    context.updatePreviewPoints([]);

    ctx.strokeStyle = context.color;
    ctx.lineWidth = context.editorService.lineWidth;
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = 'source-over';
    
    ctx.beginPath();
    ctx.moveTo(this.startPoint.x, this.startPoint.y);
    ctx.lineTo(endPoint.x, endPoint.y);
    ctx.stroke();

    this.commitBufferToActive(context);

    this.startPoint = null;
  }
}