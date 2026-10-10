import { Injectable, computed, inject, signal } from '@angular/core';

import { ProjectScoped } from '../../../core/project-scoped';

import { IOService } from '../../../services/io.service';
import { MaskVolumeService } from '../../../services/mask-volume.service';
import { SequenceService } from '../../../services/sequence.service';
import { CanvasManagerService } from '../../../features/editor/drawable-canvas/service/canvas-manager.service';
import {
  ExternalAction,
  UndoRedoService,
} from '../../../features/editor/drawable-canvas/service/undo-redo.service';
import { EditorService } from '../../../features/editor/services/editor.service';
import { ProjectionReduce, Volume3dSettingsService } from '../volume3d-settings.service';
import { ProjectionService } from './projection.service';
import { Surface, buildSurface, forEachColumnVoxel, sampleSurface, sliceToRow } from './projection-surface';

/** Voxels one stroke changed in one slice of one label. */
interface SliceDiff {
  z: number;
  label: number;
  /** Offsets in the label's volume. */
  indices: Uint32Array;
  before: Uint8Array;
  after: Uint8Array;
}

/**
 * Painting on the projection view, written back into the volume.
 *
 * The view runs the editor's tools on the surface at depth `t` of the A→B
 * segments, flattened into an image (see `Surface`). `sample` reads the label
 * volumes on that surface; `commit` writes back what a stroke changed, along
 * each segment, half the brush size on each side of the surface.
 *
 * Every slice touched is persisted: the open frame through the usual dirty
 * path, the others through `MaskVolumeService.saveDirty()`. A stroke is one
 * entry of the editor's undo timeline.
 */
@Injectable({ providedIn: 'root' })
export class ProjectionPainterService implements ProjectScoped {
  private readonly volume = inject(MaskVolumeService);
  private readonly projection = inject(ProjectionService);
  private readonly settingsService = inject(Volume3dSettingsService);
  private readonly editor = inject(EditorService);
  private readonly sequences = inject(SequenceService);
  private readonly canvasManager = inject(CanvasManagerService);
  private readonly io = inject(IOService);
  private readonly undoRedo = inject(UndoRedoService);

  /** Painting mode of the projection view. */
  readonly editing = signal(false);
  /** Slices the last finished stroke changed (feedback for the view). */
  readonly lastStrokeSlices = signal<number | null>(null);
  /** Display mode to restore when painting ends. */
  private modeBefore: ProjectionReduce | null = null;

  /** Slices written since the last flush, `z:label`. */
  private readonly pending = new Set<string>();

  /** The surface strokes are written on, or null until both curves exist and
   *  the volume is resident. */
  readonly surface = computed<Surface | null>(() => {
    const columns = this.projection.columns();
    const { zSpacing, projectionDepth } = this.settingsService.settings();
    this.volume.version();
    if (!columns || this.volume.status() !== 'ready') return null;
    const { width, height, depth } = this.volume;
    return buildSurface(columns.ends, columns.count, width, height, depth, zSpacing, projectionDepth);
  });

  /** Painting shows the surface being painted, and restores the mode after. */
  setEditing(on: boolean): void {
    if (on === this.editing()) return;
    this.editing.set(on);
    const mode = this.settingsService.settings().projectionMode;
    if (on) {
      this.modeBefore = mode;
      this.settingsService.update({ projectionMode: 'depth', projectionLabels: true });
    } else {
      if (this.modeBefore && mode === 'depth') this.settingsService.update({ projectionMode: this.modeBefore });
      this.modeBefore = null;
    }
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.setEditing(false);
    this.pending.clear();
    this.lastStrokeSlices.set(null);
  }

  /** The label volumes on the surface, one `columns * rows` image each. */
  sample(surface: Surface): Uint8Array[] {
    return this.volume.masks.map((mask) => {
      const sheet = new Uint8Array(surface.columns * surface.rows);
      sampleSurface(mask, surface, sheet);
      return sheet;
    });
  }

  /**
   * Write back what a stroke changed: `sheets` are the label images the tools
   * drew on, compared with the volume as it is now.
   */
  commit(sheets: Uint8Array[]): void {
    const surface = this.surface();
    if (!surface) return;
    const { columns, depth } = surface;
    const sliceSize = this.volume.sliceSize;
    const radius = Math.max(0.5, this.editor.lineWidth / 2);
    const before = this.sample(surface);
    const diffs: SliceDiff[] = [];
    // Voxels of the slice being written that are already recorded.
    const seen = new Uint8Array(sliceSize);
    const indices = new Growable(Uint32Array);
    const old = new Growable(Uint8Array);

    for (let z = 0; z < depth; z++) {
      const row = sliceToRow(z, surface) * columns;
      const base = z * sliceSize;
      for (let label = 0; label < before.length && label < sheets.length; label++) {
        const sheet = sheets[label];
        const was = before[label];
        const mask = this.volume.masks[label];
        for (let c = 0; c < columns; c++) {
          const value = sheet[row + c];
          if (value === was[row + c]) continue;
          forEachColumnVoxel(surface, c, radius, (local) => {
            if (!seen[local]) {
              seen[local] = 1;
              indices.push(base + local);
              old.push(mask[base + local]);
            }
            mask[base + local] = value;
          });
        }
        if (indices.length === 0) continue;
        const touched = indices.take();
        for (const index of touched) seen[index - base] = 0;
        diffs.push({
          z,
          label,
          indices: touched,
          before: old.take(),
          after: Uint8Array.from(touched, (index) => mask[index]),
        });
        this.pending.add(`${z}:${label}`);
      }
    }
    if (diffs.length === 0) return;
    this.flush();
    this.lastStrokeSlices.set(new Set(diffs.map((d) => d.z)).size);
    this.undoRedo.pushExternal(this.undoAction(this.volume.version(), diffs), this.currentLayers(diffs));
  }

  // ── Propagating changes ──────────────────────────────────────────────────

  /**
   * Announce the slices that changed: the open frame through the editor's dirty
   * tracking, the others as dirty in the volume.
   */
  private flush(): void {
    if (this.pending.size === 0) return;
    let redraw = false;
    for (const key of this.pending) {
      const [z, label] = key.split(':').map(Number);
      if (this.isOpenSlice(z, label)) {
        this.io.markLabelDirty(label);
        redraw = true;
      } else {
        this.volume.markSliceDirty(z, label);
        this.volume.markEdited(this.volume.frameIds[z], label);
        this.io.markDirty();
      }
    }
    this.pending.clear();
    if (redraw) this.canvasManager.requestRedraw.next(true);
  }

  /** Slice `z` of `label` is what the 2D editor is showing and editing. */
  private isOpenSlice(z: number, label: number): boolean {
    const mask = this.canvasManager.getAllMasks()[label];
    return (
      z === this.sequences.currentFrameIndex() &&
      !!mask &&
      this.volume.owns(mask) &&
      mask.byteOffset === z * this.volume.sliceSize
    );
  }

  /** The open frame's layers among `diffs` (their undo history follows). */
  private currentLayers(diffs: SliceDiff[]): number[] {
    return [...new Set(diffs.filter((d) => this.isOpenSlice(d.z, d.label)).map((d) => d.label))];
  }

  private undoAction(version: number, diffs: SliceDiff[]): ExternalAction {
    const apply = (which: 'before' | 'after'): number[] | null => {
      if (this.volume.status() !== 'ready' || this.volume.version() !== version) return null;
      for (const diff of diffs) {
        const mask = this.volume.masks[diff.label];
        if (!mask) return null;
        const { indices } = diff;
        const values = diff[which];
        for (let i = 0; i < indices.length; i++) mask[indices[i]] = values[i];
        this.pending.add(`${diff.z}:${diff.label}`);
      }
      const layers = this.currentLayers(diffs);
      this.flush();
      return layers;
    };
    return { undo: () => apply('before'), redo: () => apply('after') };
  }
}

/** An append-only typed array that is handed over, then reused. */
class Growable<T extends Uint8Array | Uint32Array> {
  private data: T;
  length = 0;

  constructor(private readonly type: new (length: number) => T) {
    this.data = new type(1024);
  }

  push(value: number): void {
    if (this.length === this.data.length) {
      const grown = new this.type(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }

  take(): T {
    const out = this.data.slice(0, this.length) as T;
    this.length = 0;
    return out;
  }
}
