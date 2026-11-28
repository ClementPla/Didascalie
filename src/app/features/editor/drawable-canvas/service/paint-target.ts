import { SequenceService } from '../../../../services/sequence.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';

/**
 * The mask a refinement started for. Refinements await an IPC before writing
 * their result: by then the user may have moved to another frame or label, and
 * the result belongs to neither.
 */
export interface PaintTarget {
  frameId: number;
  index: number;
  mask: Uint8Array;
  width: number;
  height: number;
}

/** The active mask of the open frame, or null when there is none. */
export function capturePaintTarget(
  canvas: CanvasManagerService,
  state: StateManagerService,
  sequence: SequenceService,
): PaintTarget | null {
  const frameId = sequence.currentFrame()?.id;
  const index = canvas.getActiveIndex();
  const mask = canvas.getAllMasks()[index];
  if (frameId == null || !mask) return null;
  return { frameId, index, mask, width: state.width, height: state.height };
}

/** True when `target` is still the active mask of the open frame. */
export function isStillTarget(
  target: PaintTarget,
  canvas: CanvasManagerService,
  state: StateManagerService,
  sequence: SequenceService,
): boolean {
  return (
    sequence.currentFrame()?.id === target.frameId &&
    canvas.getActiveIndex() === target.index &&
    canvas.getAllMasks()[target.index] === target.mask &&
    state.width === target.width &&
    state.height === target.height
  );
}
