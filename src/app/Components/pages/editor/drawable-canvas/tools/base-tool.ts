import { from_hex_to_rgb } from '../../../../../Core/misc/colors';
import { ToolContext } from '../interface';

export abstract class BaseTool {
  /**
   * Most tools need to commit the buffer to the active context at the end.
   */
  protected commitBufferToActive(context: ToolContext) {
    const bbox = context.stateService.getBoundingBox();
    const activeCtx = context.canvasManager.getActiveCtx();
    const bufferCtx = context.canvasManager.getBufferCtx();

    const x = Math.floor(bbox.x);
    const y = Math.floor(bbox.y);
    const width = Math.floor(bbox.width);
    const height = Math.floor(bbox.height);

    if (width <= 0 || height <= 0) return;

    const bufferData = bufferCtx.getImageData(x, y, width, height);
    const activeData = activeCtx.getImageData(x, y, width, height);

    const src32 = new Uint32Array(bufferData.data.buffer);
    const dst32 = new Uint32Array(activeData.data.buffer);

    const threshold = 128;

    for (let i = 0; i < src32.length; i++) {
      const srcPixel = src32[i];
      const srcAlpha = srcPixel >>> 24;

      if (srcAlpha >= threshold) {
        // Make fully opaque and copy to destination
        dst32[i] = srcPixel | 0xff000000; // Set alpha to 255
      }
      // else: keep destination pixel unchanged
    }

    activeCtx.putImageData(activeData, x, y);
  }

  protected binarizeBuffer(context: ToolContext) {
    // Check if canvas is empty
    const bufferCanvas = context.canvasManager.getBufferCanvas();
    if (bufferCanvas.width === 0 || bufferCanvas.height === 0) {
      console.warn('Buffer canvas is empty, skipping binarization.');
      return;
    }
    const ctx = bufferCanvas.getContext('2d')!;
    const bbox = context.stateService.getBoundingBox();
    const color = context.color;
    const [r, g, b] = from_hex_to_rgb(color);

    const x = bbox?.x ?? 0;
    const y = bbox?.y ?? 0;
    const width = bbox?.width ?? ctx.canvas.width;
    const height = bbox?.height ?? ctx.canvas.height;

    const imgData = ctx.getImageData(x, y, width, height);
    const data32 = new Uint32Array(imgData.data.buffer);

    // Pre-compute color in ABGR format (little-endian)
    const colorNoAlpha = (b << 16) | (g << 8) | r;

    for (let i = 0; i < data32.length; i++) {
      const alpha = data32[i] >>> 24;
      if (alpha > 128) {
        data32[i] = (alpha << 24) | colorNoAlpha;
      } else {
        data32[i] = 0;
      }
    }

    ctx.putImageData(imgData, x, y);
  }

  abstract start(event: MouseEvent, context: ToolContext): void;
  abstract draw(event: MouseEvent, context: ToolContext): void;
  abstract end(context: ToolContext): Promise<void>;
}
