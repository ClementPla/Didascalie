import { LassoTool } from './lasso-tool';
import { ToolContext } from '../interface';

export class LassoEraserTool extends LassoTool {

  override async end(context: ToolContext) {
    // 1. Verify we have enough points to make a shape
    if (this.points.length < 3) {
      this.points = []; // Reset locally
      return;
    }

    // 2. Prepare the buffer (draw the lasso shape as the erase mask).
    const bufferCtx = context.canvasManager.getBufferCtx();
    this.fillShape(bufferCtx, context.color);

    // 3. Handle the erasing logic
    if (!context.editorService.eraserPostProcess) {
      this.eraseBufferFromTargets(context);
    }

    // 4. Cleanup
    this.points = [];
    context.updatePreviewPoints([]); // Clear the preview
  }
}