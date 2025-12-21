import { BaseTool } from './base-tool';
import { ToolContext } from '../interface';
import { Point2D } from '../interface';

export class LassoTool extends BaseTool {
  protected points: Point2D[] = [];
  private isEraser: boolean;

  constructor(isEraser: boolean = false) {
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
    this.binarizeBuffer(context);       // Clean edges

    if (!context.editorService.penPostProcess) {
       if (context.editorService.swapMarkers) {
         context.swapMarkers();
       } else {
         this.commitBufferToActive(context);
       }
    }
  }

  private handleLassoEraser(context: ToolContext) {
    // If using post-process eraser (e.g. converting to SVG), handle that logic
    if (context.editorService.eraserPostProcess) {
       // Just delegate to draw/fill logic on buffer, PostProcess service handles the rest later
       const ctx = context.canvasManager.getBufferCtx();
       this.fillShape(ctx, context.color);
       return;
    }

    // Otherwise, direct erasure
    const ctxBuffer = context.canvasManager.getBufferCtx();
    
    // 1. Draw shape on buffer
    this.fillShape(ctxBuffer, context.color);
    this.binarizeBuffer(context);

    // 2. Erase from target canvases using the buffer as mask
    const targets = context.editorService.eraseAll 
      ? context.canvasManager.getAllCanvasCtx() 
      : [context.canvasManager.getActiveCtx()];

    const bbox = context.stateService.getBoundingBox();
    const bufferCanvas = context.canvasManager.getBufferCanvas();

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