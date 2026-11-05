import { Point2D, ToolContext } from '../interface';
import { pullString } from './stroke-smoothing';
import {
  commitStroke,
  eraseStrokeFromMasks,
  Rect,
} from '../../../../core/misc/label-ops';

export abstract class BaseTool {
  /** Where the brush goes for pointer position `raw`: `raw` itself, or with
   *  the stabilizer on, the end of a string pulled from the last brush point. */
  protected stabilizedPoint(context: ToolContext, raw: Point2D): Point2D {
    const radius = context.editorService.brushStabilizer * context.imagePxPerScreenPx();
    if (radius <= 0) return raw;
    return pullString(context.stateService.previousPoint, raw, radius);
  }

  /** The segment from the brush to the release point that a stabilized
   *  stroke still owes, so it ends under the pointer; null when there is none.
   *  Call from `end`, where `currentPoint` is the release point and
   *  `previousPoint` the last brush point. */
  protected catchUpSegment(context: ToolContext): { from: Point2D; to: Point2D } | null {
    if (context.editorService.brushStabilizer <= 0) return null;
    const from = context.stateService.previousPoint;
    const to = context.stateService.currentPoint;
    if (from.x < 0 || (from.x === to.x && from.y === to.y)) return null;
    context.stateService.updateMinMaxPoints(to);
    return { from, to };
  }

  /** The stroke buffer over the stroke's bounding box, as RGBA with its integer
   *  rect, or null when the stroke is empty. */
  protected readStrokeRegion(
    context: ToolContext
  ): { region: Uint8ClampedArray; rect: Rect } | null {
    const rect = context.stateService.strokeRect();
    if (!rect) return null;

    const region = context.canvasManager.readBufferRegion(rect);
    return { region, rect };
  }

  /** Write a finished drawing stroke: swapped under the stroke when a swap
   *  mode is on, else painted into the active label. */
  protected commitDrawStroke(context: ToolContext) {
    if (context.editorService.swapMarkers) context.swapMarkers();
    else this.commitBufferToActive(context);
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
