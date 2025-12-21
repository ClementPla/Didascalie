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
    ctx.lineWidth = context.editorService.lineWidth;
    ctx.strokeStyle = context.color; 
    
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();

    context.stateService.updatePreviousPoint(point);
    context.stateService.updateCurrentPoint(point);
    
    // We binarize immediately during draw for the eraser to ensure the mask is sharp
    // (This matches your original logic calling binarize inside eraserPen)
    this.binarizeBuffer(context); 

    // Apply the buffer as an eraser to the target canvas(es)
    this.applyEraserToTargets(context);
    context.redrawRequest();
  }

  async end(context: ToolContext) {
    // Post-process logic is handled by the DrawService orchestrator
  }

  private applyEraserToTargets(context: ToolContext) {
    // If we are just recording points for SVG post-process, skip canvas manipulation
    if (context.editorService.eraserPostProcess) {
      // Assuming 'svgUIService' is reachable via context or handled separately
      // context.svgUIService.addPoint(context.stateService.currentPoint);
      return; 
    }

    const bufferCanvas = context.canvasManager.getBufferCanvas();
    const bbox = context.stateService.getBoundingBox();

    // Determine which canvases to erase from
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