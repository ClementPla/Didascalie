import { ToolContext } from '../interface';
import {
  commitStroke,
  eraseStrokeFromMasks,
  intRect,
  Rect,
} from '../../../../../Core/misc/label-ops';

export abstract class BaseTool {
  /**
   * Read back the stroke buffer over its bounding box. Returns the RGBA region
   * and its integer rect, or null when the stroke is empty/off-image.
   */
  protected readStrokeRegion(
    context: ToolContext
  ): { region: Uint8ClampedArray; rect: Rect } | null {
    const w = context.stateService.width;
    const h = context.stateService.height;
    const rect = intRect(context.stateService.getBoundingBox(), w, h);
    if (!rect) return null;

    const bufferCtx = context.canvasManager.getBufferCtx();
    const region = bufferCtx.getImageData(rect.x, rect.y, rect.width, rect.height).data;
    return { region, rect };
  }

  /** Commit the current stroke into the active label mask. */
  protected commitBufferToActive(context: ToolContext) {
    const read = this.readStrokeRegion(context);
    const mask = context.canvasManager.getActiveMask();
    if (!read || !mask) return;
    commitStroke(mask, context.stateService.width, read.region, read.rect, context.value);
  }

  /** Erase the current stroke's covered pixels from the active or all masks. */
  protected eraseBufferFromTargets(context: ToolContext) {
    const read = this.readStrokeRegion(context);
    if (!read) return;

    const masks = context.editorService.eraseAll
      ? context.canvasManager.getAllMasks()
      : [context.canvasManager.getActiveMask()].filter(Boolean);
    eraseStrokeFromMasks(masks, context.stateService.width, read.region, read.rect);
  }

  abstract start(event: MouseEvent, context: ToolContext): void;
  abstract draw(event: MouseEvent, context: ToolContext): void;
  abstract end(context: ToolContext): Promise<void>;
}
