import { LassoTool } from './lasso-tool';
import { ToolContext } from '../interface';

export class LassoEraserTool extends LassoTool {

  override async end(context: ToolContext) {
    // 1. Verify we have enough points to make a shape
    if (this.points.length < 3) {
      this.points = []; // Reset locally
      return;
    }

    // 2. Prepare the buffer (Draw the shape in white/color on the buffer)
    const bufferCtx = context.canvasManager.getBufferCtx();
    
    // We reuse the fill logic from the parent class to draw the shape mask
    this.fillShape(bufferCtx, context.color); 
    
    // Clean up the mask edges
    this.binarizeBuffer(context);

    // 3. Handle the erasing logic
    if (!context.editorService.eraserPostProcess) {
      this.applyErasureToTargets(context);
    }

    // 4. Cleanup
    this.points = [];
    context.updatePreviewPoints([]); // Clear the preview

  }

  private applyErasureToTargets(context: ToolContext) {
    const bbox = context.stateService.getBoundingBox();
    const bufferCanvas = context.canvasManager.getBufferCanvas();

    // Determine targets based on "Erase All" flag
    const targets = context.editorService.eraseAll 
      ? context.canvasManager.getAllCanvasCtx() 
      : [context.canvasManager.getActiveCtx()];

    targets.forEach(ctx => {
      ctx.globalCompositeOperation = 'destination-out';
      
      ctx.drawImage(
        bufferCanvas,
        bbox.x, bbox.y, bbox.width, bbox.height,
        bbox.x, bbox.y, bbox.width, bbox.height
      );
      
      ctx.globalCompositeOperation = 'source-over';
    });
  }
}