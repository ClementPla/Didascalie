import { BaseTool } from './base-tool';
import { ToolContext } from '../interface';

export class EraserTool extends BaseTool {

  start(event: MouseEvent, context: ToolContext) {
    const point = context.getCoords(event);
    context.stateService.updatePreviousPoint(point);
  }

  draw(event: MouseEvent, context: ToolContext) {
    const point = context.getCoords(event);
    const ctx = context.canvasManager.getBufferCtx();
    const prev = context.stateService.previousPoint;

    // Draw the "Eraser Path" onto the buffer first (as white/color)
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineWidth =
      context.editorService.lineWidth * context.editorService.brushPressureScale();
    ctx.strokeStyle = context.color; 
    
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();

    context.stateService.updatePreviousPoint(point);
    context.stateService.updateCurrentPoint(point);

    // When eraserPostProcess is on we only record the stroke on the buffer; the
    // connected-component erase runs once in DrawService after the stroke ends.
    if (!context.editorService.eraserPostProcess) {
      this.eraseBufferFromTargets(context);
    }
    context.redrawRequest();
  }

  async end(context: ToolContext) {
    // Post-process logic is handled by the DrawService orchestrator
  }
}