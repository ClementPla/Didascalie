import { BaseTool } from './base-tool';
import { Point2D, ToolContext } from '../interface';

export class EraserTool extends BaseTool {

  start(event: MouseEvent, context: ToolContext) {
    const point = context.getCoords(event);
    context.stateService.updatePreviousPoint(point);
  }

  draw(event: MouseEvent, context: ToolContext) {
    const point = this.stabilizedPoint(context, context.getCoords(event));
    this.eraseSegment(context, context.stateService.previousPoint, point);

    context.stateService.updatePreviousPoint(point);
    context.stateService.updateCurrentPoint(point);
  }

  async end(context: ToolContext) {
    const tail = this.catchUpSegment(context);
    if (tail) this.eraseSegment(context, tail.from, tail.to);
  }

  private eraseSegment(context: ToolContext, prev: Point2D, point: Point2D) {
    const ctx = context.canvasManager.getBufferCtx();

    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineWidth =
      context.editorService.lineWidth * context.editorService.brushPressureScale();
    ctx.strokeStyle = context.color;

    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    // A point that did not move is erased as a dot (a zero-length line draws
    // nothing).
    if (prev.x === point.x && prev.y === point.y) {
      ctx.lineTo(point.x + 0.1, point.y + 0.1);
    } else {
      ctx.lineTo(point.x, point.y);
    }
    ctx.stroke();

    // With `eraserPostProcess`, DrawService erases the touched components when
    // the stroke ends.
    if (!context.editorService.eraserPostProcess) {
      this.eraseBufferFromTargets(context);
    }
    context.redrawRequest();
  }
}
