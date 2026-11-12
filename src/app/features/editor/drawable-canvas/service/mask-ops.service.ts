import { Injectable, inject, signal } from '@angular/core';
import { api } from '../../../../lib/api';
import { decodeRle8 } from '../../../../lib/rle8';
import { base64ToUint8 } from '../../../../core/misc/base64';
import {
  dilate,
  erode,
  fillGaps,
  fillHoles,
  invertInUnlabelled,
  invertWhole,
  keepLargest,
  removeIslands,
  smooth,
  subtractFromOthers,
  takeAddedFromOthers,
} from '../../../../core/misc/mask-ops';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { UndoRedoService } from './undo-redo.service';
import { LabelsService } from '../../../../services/labels/labels.service';
import { ProjectService } from '../../../../services/project/project.service';
import { IOService } from '../../../../services/io.service';
import { SequenceService } from '../../../../services/sequence.service';
import { MaskVolumeService } from '../../../../services/mask-volume.service';
import { NotificationService } from '../../../../services/notification.service';

export type InvertMode = 'whole' | 'unlabelled';
export type MaskOpsTarget = 'active' | 'all' | 'visible' | 'selected';
export type MorphOp = 'holes' | 'islands' | 'largest' | 'dilate' | 'erode' | 'smooth';
/** The clean-up operations of the panel. */
export type CleanOp = MorphOp | 'gaps';

/** One frame's label masks, in label order. */
interface FrameMasks {
  masks: Uint8Array[];
  w: number;
  h: number;
}

/** Changes `masks` in place. */
type FrameOp = (frame: FrameMasks) => void;

/**
 * The Boolean panel: whole-mask operations on the open frame (one undo step),
 * or on every frame of the sequence (only the open frame can be undone).
 * Raster only: vector shapes are left as they are.
 */
@Injectable({ providedIn: 'root' })
export class MaskOpsService {
  private canvasManager = inject(CanvasManagerService);
  private state = inject(StateManagerService);
  private undoRedo = inject(UndoRedoService);
  private labels = inject(LabelsService);
  private project = inject(ProjectService);
  private io = inject(IOService);
  private sequence = inject(SequenceService);
  private volume = inject(MaskVolumeService);
  private notifications = inject(NotificationService);

  // ── Panel state (outlives the panel, which closes with the settings) ─────
  readonly invertMode = signal<InvertMode>('unlabelled');
  readonly target = signal<MaskOpsTarget>('active');
  /** Label ids, for the 'selected' target. */
  readonly selectedLabels = signal<number[]>([]);
  readonly radius = signal(2);
  readonly holeArea = signal(100);
  readonly islandArea = signal(100);
  readonly smoothing = signal(2);
  /** Widest gap Fill gaps closes, in pixels. */
  readonly gapWidth = signal(3);
  /** Fill gaps also between instances of one label. */
  readonly gapsBetweenInstances = signal(true);
  /** What an operation adds to a label, it takes from the others. */
  readonly takeFromOthers = signal(false);
  readonly allFrames = signal(false);
  /** The clean-up operation picked in the panel. */
  readonly cleanOp = signal<CleanOp>('holes');
  /** Frames done / to do while an all-frames run is going. */
  readonly progress = signal<{ done: number; total: number } | null>(null);

  // ── Operations ───────────────────────────────────────────────────────────

  /** Invert the active label. */
  invert(): Promise<void> {
    const index = this.labels.getActiveIndex();
    if (index < 0) return Promise.resolve();
    const value = this.labels.paintValue(this.project.isInstanceSegmentation());
    const mode = this.invertMode();
    return this.run(({ masks }) => {
      if (mode === 'whole') invertWhole(masks[index], value);
      else invertInUnlabelled(masks, index, value);
    });
  }

  /** Clear, in every other label, what the active label covers. */
  subtractActive(): Promise<void> {
    const index = this.labels.getActiveIndex();
    if (index < 0) return Promise.resolve();
    return this.run(({ masks }) => subtractFromOthers(masks, index));
  }

  /** A morphological operation on each target label. */
  morph(op: MorphOp): Promise<void> {
    const targets = this.targetIndices();
    if (targets.length === 0) {
      this.notifications.warn('No label to apply it to');
      return Promise.resolve();
    }
    const radius = this.radius();
    const holeArea = this.holeArea();
    const islandArea = this.islandArea();
    const sigma = this.smoothing();
    const take = this.takeFromOthers();
    const apply = (m: Uint8Array, w: number, h: number): Uint8Array => {
      switch (op) {
        case 'holes':
          return fillHoles(m, w, h, holeArea > 0 ? holeArea : Infinity);
        case 'islands':
          return removeIslands(m, w, h, islandArea);
        case 'largest':
          return keepLargest(m, w, h);
        case 'dilate':
          return dilate(m, w, h, radius);
        case 'erode':
          return erode(m, w, h, radius);
        case 'smooth':
          return smooth(m, w, h, sigma);
      }
    };
    return this.run(({ masks, w, h }) => {
      const originals = take ? masks.map((m) => m.slice()) : [];
      for (const t of targets) {
        if (masks[t]) masks[t].set(apply(masks[t], w, h));
      }
      if (take) {
        for (const t of targets) if (masks[t]) takeAddedFromOthers(originals[t], masks, originals, t);
      }
    });
  }

  /** Fill the gaps between labels that nearly touch; the target labels
   *  take their side of each gap. */
  fillGaps(): Promise<void> {
    const targets = this.targetIndices();
    if (targets.length === 0) {
      this.notifications.warn('No label to apply it to');
      return Promise.resolve();
    }
    const gap = this.gapWidth();
    const instances =
      this.project.isInstanceSegmentation() && this.gapsBetweenInstances();
    return this.run(({ masks, w, h }) => fillGaps(masks, w, h, gap, targets, instances));
  }

  /** Label indices the morphology acts on. */
  targetIndices(): number[] {
    const labels = this.labels.listSegmentationLabels;
    switch (this.target()) {
      case 'active': {
        const index = this.labels.getActiveIndex();
        return index >= 0 ? [index] : [];
      }
      case 'all':
        return labels.map((_, i) => i);
      case 'visible':
        return labels.flatMap((l, i) => (l.isVisible ? [i] : []));
      case 'selected': {
        const ids = new Set(this.selectedLabels());
        return labels.flatMap((l, i) => (ids.has(l.id) ? [i] : []));
      }
    }
  }

  // ── Running ──────────────────────────────────────────────────────────────

  private async run(op: FrameOp): Promise<void> {
    if (this.progress()) return;
    this.applyToOpenFrame(op);
    if (this.allFrames()) await this.applyToOtherFrames(op);
  }

  /** The open frame, as one undo step. */
  private applyToOpenFrame(op: FrameOp): void {
    const masks = this.canvasManager.getAllMasks();
    if (masks.length === 0) return;
    const before = masks.map((m) => m.slice());
    op({ masks, w: this.state.width, h: this.state.height });
    const changed = changedLayers(before, masks);
    if (changed.length === 0) return;
    this.undoRedo.snapshotLayers(changed);
    this.state.recomputeCanvasSum = true;
    this.canvasManager.requestRedraw.next(true);
    this.io.markDirty();
  }

  /** Every other frame of the sequence, saved as it goes. */
  private async applyToOtherFrames(op: FrameOp): Promise<void> {
    const openId = this.sequence.currentFrame()?.id;
    const frames = this.sequence.frames().filter((f) => f.id !== openId);
    const labels = this.labels.listSegmentationLabels;
    if (frames.length === 0 || labels.length === 0) return;

    let failed = 0;
    let volumeEdited = false;
    this.progress.set({ done: 0, total: frames.length });
    try {
      for (const [n, frame] of frames.entries()) {
        try {
          // 3D mode: the frame's masks are resident; edit them there.
          const slices = this.volume.slicesFor(frame.id);
          if (slices) {
            const before = slices.map((m) => m.slice());
            op({ masks: slices, w: frame.width, h: frame.height });
            const z = this.volume.frameIds.indexOf(frame.id);
            for (const i of changedLayers(before, slices)) {
              this.volume.markSliceDirty(z, i);
              volumeEdited = true;
            }
          } else {
            const loaded = await this.loadFrame(frame.id, frame.width, frame.height);
            const before = loaded.masks.map((m) => m.slice());
            op(loaded);
            for (const i of changedLayers(before, loaded.masks)) {
              await api.saveAnnotation(frame.id, labels[i].id, loaded.masks[i]);
              this.volume.syncSaved(frame.id, labels[i].id, loaded.masks[i]);
            }
          }
        } catch (error) {
          console.error(`Mask operation failed on frame ${frame.id}:`, error);
          failed++;
        }
        this.progress.set({ done: n + 1, total: frames.length });
        // Let the panel show progress.
        await new Promise((resolve) => setTimeout(resolve));
      }
    } finally {
      this.progress.set(null);
    }
    // Volume slices are persisted with the next save.
    if (volumeEdited) this.io.markDirty();
    if (failed > 0) {
      this.notifications.error(`Failed on ${failed} frame${failed > 1 ? 's' : ''}`, 'See the log for details.');
    } else {
      this.notifications.success(`Applied to all ${frames.length + 1} frames`);
    }
  }

  /** A frame's label masks from the project, empty where it has none. */
  private async loadFrame(frameId: number, width: number, height: number): Promise<FrameMasks> {
    const labels = this.labels.listSegmentationLabels;
    const annotations = await api.loadAnnotations(frameId);
    const w = annotations[0]?.width ?? width;
    const h = annotations[0]?.height ?? height;
    const masks = labels.map(() => new Uint8Array(w * h));
    for (const a of annotations) {
      const index = labels.findIndex((l) => l.id === a.labelId);
      if (index < 0 || a.width !== w || a.height !== h) continue;
      masks[index] = decodeRle8(base64ToUint8(a.rle8Base64), w * h);
    }
    return { masks, w, h };
  }
}

function changedLayers(before: Uint8Array[], after: Uint8Array[]): number[] {
  const changed: number[] = [];
  after.forEach((mask, i) => {
    const old = before[i];
    for (let p = 0; p < mask.length; p++) {
      if (mask[p] !== old[p]) {
        changed.push(i);
        return;
      }
    }
  });
  return changed;
}
