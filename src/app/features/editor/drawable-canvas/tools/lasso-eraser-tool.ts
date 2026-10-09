import { LassoTool } from './lasso-tool';
import { ToolContext } from '../interface';

export class LassoEraserTool extends LassoTool {

  override async end(context: ToolContext) {
    if (this.points.length < 3) {
      this.points = []; // Reset locally
      return;
    }

    const bufferCtx = context.canvasManager.getBufferCtx();
    this.fillShape(bufferCtx, context.color);

    if (!context.editorService.eraserPostProcess) {
      this.eraseBufferFromTargets(context);
    }

    this.points = [];
    context.updatePreviewPoints([]); // Clear the preview
  }
}