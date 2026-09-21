import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Subject } from 'rxjs';

import { api, Frame } from '../lib/api';
import { ProjectScoped } from '../core/project-scoped';
import { LabelsService } from './labels/labels.service';
import { SequenceService } from './sequence.service';

export type VolumeStatus = 'off' | 'loading' | 'ready' | 'error';

/** A label layer of one slice was edited (see `IOService.markLabelDirty`). */
export interface SliceEdit {
  /** Slice index, i.e. the frame's index in the sequence. */
  z: number;
  /** Label layer index, in `LabelsService.listSegmentationLabels` order. */
  label: number;
}

/** Slices larger than this on either side use the tiled large-image path,
 *  which never holds a full-resolution frame in memory. */
const MAX_SLICE_SIDE = 4096;
/** Upper bound on the resident volume: the label volumes, the image volume,
 *  and one more volume's worth for the 3D views (the projection's packed
 *  labels). */
const MAX_VOLUME_BYTES = 1.5 * 1024 ** 3;

/**
 * The open sequence as a `W×H×D` voxel volume, for the editor's 3D mode.
 *
 * # Storage
 *
 * One contiguous `Uint8Array` per segmentation label, Z (the frame index)
 * being the slowest axis, so slice `z` of a label is the byte range
 * `[z*W*H, (z+1)*W*H)`. The 2D editor does not copy slices in and out: while
 * the volume is ready, `IOService.load()` points the canvas manager's label
 * layers at `subarray` views of the current slice (`slicesFor`). Every tool,
 * the compositor and undo therefore write straight into the volume, and
 * changing frame costs no IPC.
 *
 * Persistence is unchanged: the editor still saves the current frame before it
 * navigates, and that frame's masks *are* the slice views.
 *
 * # Lifecycle
 *
 * While `enabled`, the volume follows the open sequence: a new sequence
 * releases the old volume (`released$`, so the canvas manager can take owned
 * copies first) and loads the new one (`ready$` when the masks are resident;
 * the image volume follows and flips `imageReady`). Writes that bypass the
 * editor — propagation, clearing the sequence — must call `reload()`.
 *
 * This service deliberately imports neither `IOService` nor the canvas
 * manager; they react to its events, which keeps the dependency one-way.
 */
@Injectable({ providedIn: 'root' })
export class MaskVolumeService implements ProjectScoped {
  private readonly sequences = inject(SequenceService);
  private readonly labels = inject(LabelsService);

  /** The user wants 3D mode. Survives sequence changes. */
  readonly enabled = signal(false);
  readonly status = signal<VolumeStatus>('off');
  /** Why the volume could not be built (ineligible sequence, load failure). */
  readonly error = signal<string | null>(null);
  /** Fraction of the label volumes loaded, 0..1, while `status` is loading. */
  readonly progress = signal(0);
  /** The image (luminance) volume is resident. Loads after the masks. */
  readonly imageReady = signal(false);
  /** Bumped whenever the volume's contents are replaced wholesale. */
  readonly version = signal(0);

  /** The masks became resident: layers may now be bound to slice views. */
  readonly ready$ = new Subject<void>();
  /** Emitted just before the buffers are dropped: take copies now. */
  readonly released$ = new Subject<void>();
  /** A slice's label layer changed through the editor. */
  readonly edited$ = new Subject<SliceEdit>();
  /** Scroll request from the canvas (±1 slice), handled by the editor. */
  readonly sliceStepRequested$ = new Subject<number>();
  /** Request to show slice `z` (e.g. picked in the 3D view), handled by the
   *  editor. */
  readonly sliceSelectRequested$ = new Subject<number>();

  width = 0;
  height = 0;
  depth = 0;
  /** Frame ids along Z, in sequence order. */
  frameIds: number[] = [];
  /** Label ids, one per mask volume, in layer order at load time. */
  labelIds: number[] = [];
  /** One `W*H*D` volume per label. Empty unless `status` is ready. */
  masks: Uint8Array[] = [];
  /** `W*H*D` luminance, or null until `imageReady`. */
  image: Uint8Array | null = null;

  /** Identity of the frame list the current/last load was started for. */
  private loadedKey: string | null = null;
  /** Invalidates in-flight loads when a newer one starts or the mode ends. */
  private loadToken = 0;
  /**
   * Saves that landed while the volume was loading, keyed `frameId:labelId`.
   * The load may have read those rows before the save, so they are replayed
   * over the loaded data.
   */
  private readonly pendingSlices = new Map<string, Uint8Array>();
  /**
   * Slices changed in the volume directly (not through the open frame's
   * layers), keyed `z:labelIndex`: they are persisted by `saveDirty()`, which
   * `IOService.save()` calls.
   */
  private readonly dirtySlices = new Set<string>();

  constructor() {
    effect(() => {
      const on = this.enabled();
      const frames = this.sequences.frames();
      untracked(() => {
        if (!on) return;
        // `frames` is re-emitted for unrelated changes (e.g. the reviewed
        // flag), so compare the frame list itself.
        if (frameKey(frames) === this.loadedKey) return;
        void this.load(frames);
      });
    });
  }

  get sliceSize(): number {
    return this.width * this.height;
  }

  enable(): void {
    this.enabled.set(true);
  }

  disable(): void {
    this.enabled.set(false);
    this.loadToken++;
    this.loadedKey = null;
    this.pendingSlices.clear();
    this.release();
    this.error.set(null);
  }

  /** Re-read the whole volume from the project, e.g. after a bulk write. */
  reload(): void {
    if (!this.enabled()) return;
    void this.load(this.sequences.frames());
  }

  /**
   * Why `frames` cannot be opened as a volume with `labelCount` labels, or
   * null when it can.
   */
  ineligibility(frames: readonly Frame[], labelCount: number): string | null {
    if (frames.length < 2) return '3D mode needs a sequence of at least two frames.';
    if (labelCount === 0) return '3D mode needs at least one segmentation label.';
    const { width, height } = frames[0];
    if (frames.some((f) => f.width !== width || f.height !== height)) {
      return 'Every frame of the sequence must have the same size.';
    }
    if (Math.max(width, height) > MAX_SLICE_SIDE) {
      return `Frames larger than ${MAX_SLICE_SIDE} px are not supported in 3D mode.`;
    }
    const bytes = width * height * frames.length * (labelCount + 2);
    if (bytes > MAX_VOLUME_BYTES) {
      const gb = (bytes / 1024 ** 3).toFixed(1);
      return `The volume would need ${gb} GB of memory (limit ${MAX_VOLUME_BYTES / 1024 ** 3} GB).`;
    }
    return null;
  }

  /**
   * The label layers of `frameId` as views into the volume, in the current
   * label order — or null when the volume is not ready, does not hold that
   * frame, or was built for a different label list.
   */
  slicesFor(frameId: number): Uint8Array[] | null {
    if (this.status() !== 'ready' || !this.matchesLabels()) return null;
    const z = this.frameIds.indexOf(frameId);
    if (z < 0) return null;
    const size = this.sliceSize;
    return this.masks.map((m) => m.subarray(z * size, (z + 1) * size));
  }

  /** True when `mask` is a view into one of the mask volumes. */
  owns(mask: Uint8Array): boolean {
    return this.masks.some((m) => m.buffer === mask.buffer);
  }

  /**
   * A frame's mask was just persisted. Keeps the volume in step with saves it
   * did not see: a frame saved while the volume was loading, or a mask that
   * was not bound to the volume.
   */
  syncSaved(frameId: number, labelId: number, mask: Uint8Array): void {
    if (this.status() === 'loading') {
      this.pendingSlices.set(`${frameId}:${labelId}`, mask.slice());
      return;
    }
    if (this.status() === 'ready' && !this.owns(mask)) {
      this.writeSlice(frameId, labelId, mask);
    }
  }

  /** Slice `z` of label `label` was written directly: persist it on save. */
  markSliceDirty(z: number, label: number): void {
    if (this.status() === 'ready') this.dirtySlices.add(`${z}:${label}`);
  }

  hasDirtySlices(): boolean {
    return this.dirtySlices.size > 0;
  }

  /** Persist the slices written directly since the last save. */
  async saveDirty(): Promise<void> {
    const jobs = this.takeDirty();
    for (const { frameId, labelId, data } of jobs) {
      await api.saveAnnotation(frameId, labelId, data);
    }
  }

  /** The dirty slices as copies, and forget them. */
  private takeDirty(): { frameId: number; labelId: number; data: Uint8Array }[] {
    const size = this.sliceSize;
    const jobs = [...this.dirtySlices].map((key) => {
      const [z, label] = key.split(':').map(Number);
      return {
        frameId: this.frameIds[z],
        labelId: this.labelIds[label],
        data: this.masks[label].slice(z * size, (z + 1) * size),
      };
    });
    this.dirtySlices.clear();
    return jobs.filter((j) => j.frameId != null && j.labelId != null);
  }

  /** Called by `IOService.markLabelDirty`: a layer of `frameId` changed. */
  markEdited(frameId: number, label: number): void {
    if (this.status() !== 'ready') return;
    const z = this.frameIds.indexOf(frameId);
    if (z >= 0) this.edited$.next({ z, label });
  }

  /** @see ProjectScoped — the preference survives, the data does not. */
  resetForProject(): void {
    this.loadToken++;
    this.loadedKey = null;
    this.pendingSlices.clear();
    // The project was saved on close; by now the connection may point at the
    // next project, where these frame ids mean other frames.
    this.dirtySlices.clear();
    this.release();
    this.error.set(null);
  }

  // ==========================================
  // Loading
  // ==========================================

  private async load(frames: readonly Frame[]): Promise<void> {
    const token = ++this.loadToken;
    this.loadedKey = frameKey(frames);
    this.pendingSlices.clear();
    this.release();

    const labels = this.labels.listSegmentationLabels;
    const reason = this.ineligibility(frames, labels.length);
    if (reason) {
      this.error.set(reason);
      this.status.set('error');
      return;
    }

    this.error.set(null);
    this.progress.set(0);
    this.status.set('loading');

    const frameIds = frames.map((f) => f.id);
    const labelIds = labels.map((l) => l.id);
    try {
      const masks: Uint8Array[] = [];
      for (const labelId of labelIds) {
        const buffer = await api.loadLabelVolume(frameIds, labelId);
        if (token !== this.loadToken) return;
        masks.push(new Uint8Array(buffer));
        this.progress.set(masks.length / labelIds.length);
      }

      this.width = frames[0].width;
      this.height = frames[0].height;
      this.depth = frames.length;
      this.frameIds = frameIds;
      this.labelIds = labelIds;
      this.masks = masks;
      for (const [key, mask] of this.pendingSlices) {
        const [frameId, labelId] = key.split(':').map(Number);
        this.writeSlice(frameId, labelId, mask);
      }
      this.pendingSlices.clear();

      this.status.set('ready');
      this.version.update((v) => v + 1);
      this.ready$.next();
    } catch (error) {
      if (token !== this.loadToken) return;
      console.error('Failed to load the mask volume:', error);
      this.error.set(String(error));
      this.status.set('error');
      return;
    }

    // The 2D editor only needs the masks; the image volume backs the 3D views.
    try {
      const image = await api.loadSequenceImageVolume(frameIds);
      if (token !== this.loadToken) return;
      this.image = new Uint8Array(image);
      this.imageReady.set(true);
    } catch (error) {
      if (token !== this.loadToken) return;
      console.error('Failed to load the image volume:', error);
    }
  }

  private release(): void {
    // Never drop edits: slices written directly are saved from copies.
    if (this.dirtySlices.size > 0) {
      const jobs = this.takeDirty();
      void (async () => {
        for (const { frameId, labelId, data } of jobs) {
          await api.saveAnnotation(frameId, labelId, data).catch((error) =>
            console.error('Failed to save a volume slice:', error),
          );
        }
      })();
    }
    if (this.masks.length > 0) this.released$.next();
    this.masks = [];
    this.image = null;
    this.frameIds = [];
    this.labelIds = [];
    this.width = this.height = this.depth = 0;
    this.imageReady.set(false);
    this.status.set('off');
  }

  private writeSlice(frameId: number, labelId: number, mask: Uint8Array): void {
    const z = this.frameIds.indexOf(frameId);
    const li = this.labelIds.indexOf(labelId);
    if (z < 0 || li < 0 || mask.length !== this.sliceSize) return;
    this.masks[li].set(mask, z * this.sliceSize);
  }

  /** The volume was built for the current label list. */
  matchesLabels(): boolean {
    const current = this.labels.listSegmentationLabels;
    return (
      current.length === this.labelIds.length &&
      current.every((l, i) => l.id === this.labelIds[i])
    );
  }
}

function frameKey(frames: readonly Frame[]): string {
  return frames.map((f) => f.id).join(',');
}
