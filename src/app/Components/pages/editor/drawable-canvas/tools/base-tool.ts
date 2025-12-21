import { ToolContext } from '../interface';

export abstract class BaseTool {
  
  /**
   * Most tools need to commit the buffer to the active context at the end.
   */
  protected commitBufferToActive(context: ToolContext) {
    const bbox = context.stateService.getBoundingBox();
    const activeCtx = context.canvasManager.getActiveCtx();
    const bufferCanvas = context.canvasManager.getBufferCanvas();

    activeCtx.drawImage(
      bufferCanvas,
      bbox.x, bbox.y, bbox.width, bbox.height,
      bbox.x, bbox.y, bbox.width, bbox.height
    );
    
  }

  /**
   * Standard OpenCV binarization to keep masks clean.
   */
  protected binarizeBuffer(context: ToolContext) {

    // Guard clause
    if (!context.openCV.cv_ready) {
      console.warn('OpenCV not loaded, cannot binarize buffer.');
      return;
    }

    // Check if canvas is empty
    const bufferCanvas = context.canvasManager.getBufferCanvas();
    if (bufferCanvas.width === 0 || bufferCanvas.height === 0) {
      console.warn('Buffer canvas is empty, skipping binarization.');
      return;
    }
    context.openCV.binarizeCanvasAlphaBased(  
      context.canvasManager.getBufferCtx(),
      context.stateService.getBoundingBox(),
      context.color
    );
  }

  abstract start(event: MouseEvent, context: ToolContext): void;
  abstract draw(event: MouseEvent, context: ToolContext): void;
  abstract end(context: ToolContext): Promise<void>;
}