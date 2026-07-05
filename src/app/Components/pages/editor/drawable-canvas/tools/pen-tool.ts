import { BaseTool } from './base-tool';
import { ToolContext } from '../interface';

export class PenTool extends BaseTool {
  
  start(event: MouseEvent, context: ToolContext) {
    const point = context.getCoords(event);
    // Initialize the previous point for smooth line drawing
    context.stateService.updatePreviousPoint(point);
    context.stateService.updateCurrentPoint(point);
  }

  draw(event: MouseEvent, context: ToolContext) {
    const point = context.getCoords(event);
    const ctx = context.canvasManager.getBufferCtx();
    const prev = context.stateService.previousPoint;

    // Drawing settings. Radius scales with pen/touch pressure (no-op on mouse
    // or when pressure sensitivity is off).
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineWidth =
      context.editorService.lineWidth * context.editorService.brushPressureScale();
    ctx.strokeStyle = context.color;
    ctx.fillStyle = context.color;

    ctx.beginPath();
    
    // Logic: If mouse hasn't moved much, draw a dot; otherwise draw a line
    if (prev.x === point.x && prev.y === point.y) {
       ctx.moveTo(prev.x, prev.y);
       ctx.lineTo(point.x + 0.1, point.y + 0.1); 
    } else {
       ctx.moveTo(prev.x, prev.y);
       ctx.lineTo(point.x, point.y);
    }
    
    ctx.stroke();

    // Update state for the next segment
    context.stateService.updatePreviousPoint(point);
    context.stateService.updateCurrentPoint(point);
    
    // Trigger a "single draw" update for performance (optional)
    context.singleDrawRequest(ctx);
  }

  async end(context: ToolContext) {

    if (!context.editorService.penPostProcess) {
      if (context.editorService.swapMarkers) {
        context.swapMarkers();
      } else {
        this.commitBufferToActive(context);
      }
    }
  }
}