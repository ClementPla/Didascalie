import { ToolContext } from '../interface';
import {
  commitStroke,
  eraseStrokeFromMasks,
  intRect,
  Rect,
} from '../../../../core/misc/label-ops';

export abstract class BaseTool {
  /** The stroke buffer over the stroke's bounding box, as RGBA with its integer
   *  rect, or null when the stroke is empty. */
  protected readStrokeRegion(
    context: ToolContext
  ): { region: Uint8ClampedArray; rect: Rect } | null {
    const w = context.stateService.width;
    const h = context.stateService.height;
    const rect = intRect(context.stateService.getBoundingBox(), w, h);
    if (!rect) return null;

    const region = context.canvasManager.readBufferRegion(rect);
    return { region, rect };
  }

  protected commitBufferToActive(context: ToolContext) {
    const read = this.readStrokeRegion(context);
    const mask = context.canvasManager.getActiveMask();
    if (!read || !mask) return;
    commitStroke(mask, context.stateService.width, read.region, read.rect, context.value);
  }

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
