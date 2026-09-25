import { Injectable, inject, signal } from '@angular/core';

import { ProjectScoped } from '../../../core/project-scoped';

import { IOService } from '../../../services/io.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { MaskVolumeService } from '../../../services/mask-volume.service';
import { SequenceService } from '../../../services/sequence.service';
import { CanvasManagerService } from '../../../features/editor/drawable-canvas/service/canvas-manager.service';
import { DrawService } from '../../../features/editor/drawable-canvas/service/draw.service';
import {
  ExternalAction,
  UndoRedoService,
} from '../../../features/editor/drawable-canvas/service/undo-redo.service';
import { EditorService } from '../../../features/editor/services/editor.service';
import { ProjectionReduce, Volume3dSettingsService } from '../volume3d-settings.service';
import { ProjectionService } from './projection.service';
import { forEachDabPoint } from './projection-brush';

/** Voxels one stroke changed in one slice of one label. */
interface SliceDiff {
  z: number;
  label: number;
  indices: number[];
  before: number[];
  after: number[];
  /** Slice-local flags: voxel already recorded in this stroke. */
  seen: Uint8Array;
}

interface Stroke {
  /** Volume version the stroke was made on; undo is void once it changes. */
  version: number;
  targets: number[];
  value: number;
  diffs: Map<string, SliceDiff>;
  last: { col: number; z: number } | null;
}

/**
 * Painting on the projection view, written back into the volume.
 *
 * A projection pixel stands for a whole A→B segment of one slice; strokes are
 * written at depth `t` along those segments (`projectionDepth`, 0 = on A,
 * 1 = on B). Each dab is a ball of the brush's radius, in image pixels: along
 * the curves (columns), across slices (scaled by the slice spacing) and along
 * the segment. The active label and instance are painted; with the eraser
 * tool the dab clears the active label (or every label with "erase all").
 *
 * Every slice a stroke touches is persisted: the open frame through the usual
 * dirty/autosave path, the others through `MaskVolumeService.saveDirty()`.
 * A stroke is one entry of the editor's undo timeline.
 */
@Injectable({ providedIn: 'root' })
export class ProjectionPainterService implements ProjectScoped {
  private readonly volume = inject(MaskVolumeService);
  private readonly projection = inject(ProjectionService);
  private readonly settingsService = inject(Volume3dSettingsService);
  private readonly editor = inject(EditorService);
  private readonly draw = inject(DrawService);
  private readonly labels = inject(LabelsService);
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

  private stroke: Stroke | null = null;
  /** Slices written since the last flush, `z:label`. */
  private readonly pending = new Set<string>();
  private flushScheduled = false;

  /** Painting shows the surface being painted, and restores the mode after. */
  setEditing(on: boolean): void {
    if (on === this.editing()) return;
    this.editing.set(on);
    const mode = this.settingsService.settings().projectionMode;
    if (on) {
      this.modeBefore = mode;
      // Show the surface being painted, with its labels.
      this.settingsService.update({ projectionMode: 'depth', projectionLabels: true });
    } else {
      this.end();
      if (this.modeBefore && mode === 'depth') this.settingsService.update({ projectionMode: this.modeBefore });
      this.modeBefore = null;
    }
  }

  /**
   * @see ProjectScoped
   *
   * Painting mode is sticky: `setEditing(true)` forces the projection to depth
   * mode and remembers what to restore. Nothing reset it on a project switch,
   * so closing a project mid-stroke left `editing` latched true, `modeBefore`
   * pointing at the old project's display mode, and a half-written stroke
   * queued for flush against a database that had moved on.
   */
  resetForProject(): void {
    this.setEditing(false);
    this.stroke = null;
    this.pending.clear();
    this.flushScheduled = false;
    this.lastStrokeSlices.set(null);
  }

  get painting(): boolean {
    return this.stroke !== null;
  }

  /** Start a stroke at projection position (`col`, `z`), both fractional. */
  begin(col: number, z: number): void {
    if (!this.editing() || this.volume.status() !== 'ready' || !this.projection.columns()) return;
    const erase = this.editor.isEraser();
    const active = this.labels.getActiveIndex();
    const targets =
      erase && this.editor.eraseAll ? this.volume.masks.map((_, i) => i) : [active];
    if (targets.some((i) => !this.volume.masks[i])) return;
    this.stroke = {
      version: this.volume.version(),
      targets,
      value: erase ? 0 : this.draw.getActiveValue(),
      diffs: new Map(),
      last: null,
    };
    this.moveTo(col, z);
  }

  /** Continue the stroke: dabs spaced along the segment from the last point. */
  moveTo(col: number, z: number): void {
    const stroke = this.stroke;
    if (!stroke) return;
    const zs = this.settingsService.settings().zSpacing;
    const radius = this.radius();
    const from = stroke.last ?? { col, z };
    // Distance in image pixels (slices scaled by their spacing).
    const distance = Math.hypot(col - from.col, (z - from.z) * zs);
    const steps = Math.max(1, Math.ceil(distance / Math.max(0.5, radius / 3)));
    for (let i = stroke.last ? 1 : 0; i <= steps; i++) {
      const f = i / steps;
      this.dab(from.col + (col - from.col) * f, from.z + (z - from.z) * f);
    }
    stroke.last = { col, z };
    this.scheduleFlush();
  }

  /** Finish the stroke and record it for undo. */
  end(): void {
    const stroke = this.stroke;
    this.stroke = null;
    if (!stroke || stroke.diffs.size === 0) return;
    this.flush();

    const diffs = [...stroke.diffs.values()];
    this.lastStrokeSlices.set(new Set(diffs.map((d) => d.z)).size);
    for (const diff of diffs) {
      diff.after = diff.indices.map(() => stroke.value);
      diff.seen = new Uint8Array(0); // only needed while painting
    }
    this.undoRedo.pushExternal(this.undoAction(stroke.version, diffs), this.currentLayers(diffs));
  }

  // ==========================================
  // Writing
  // ==========================================

  private radius(): number {
    return Math.max(0.5, this.editor.lineWidth / 2);
  }

  private dab(col: number, zf: number): void {
    const columns = this.projection.columns();
    if (!columns || !this.stroke) return;
    const { zSpacing, projectionDepth } = this.settingsService.settings();
    forEachDabPoint(
      columns.ends,
      columns.count,
      this.volume.depth,
      col,
      zf,
      this.radius(),
      zSpacing,
      projectionDepth,
      (x, y, z) => this.write(x, y, z),
    );
  }

  private write(x: number, y: number, z: number): void {
    const stroke = this.stroke!;
    const { width, height, sliceSize } = this.volume;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    const local = yi * width + xi;
    const index = z * sliceSize + local;
    for (const label of stroke.targets) {
      const mask = this.volume.masks[label];
      if (mask[index] === stroke.value) continue;
      const key = `${z}:${label}`;
      let diff = stroke.diffs.get(key);
      if (!diff) {
        diff = { z, label, indices: [], before: [], after: [], seen: new Uint8Array(sliceSize) };
        stroke.diffs.set(key, diff);
      }
      if (!diff.seen[local]) {
        diff.seen[local] = 1;
        diff.indices.push(index);
        diff.before.push(mask[index]);
      }
      mask[index] = stroke.value;
      this.pending.add(key);
    }
  }

  // ==========================================
  // Propagating changes
  // ==========================================

  /**
   * Flush once per burst of pointer events. Scheduled as a task, not an
   * animation frame: the main window's frames stop while it is hidden, and
   * the projection may be painted from a detached window.
   */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.flushChannel.port2.postMessage(null);
  }
  private readonly flushChannel = (() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      this.flushScheduled = false;
      this.flush();
    };
    return channel;
  })();

  /**
   * Tell everyone which slices changed: the open frame goes through the
   * editor's dirty tracking (and is redrawn), other slices are marked dirty in
   * the volume. Both reach the 3D views through `edited$`.
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
        const values = diff[which];
        for (let i = 0; i < diff.indices.length; i++) mask[diff.indices[i]] = values[i];
        this.pending.add(`${diff.z}:${diff.label}`);
      }
      const layers = this.currentLayers(diffs);
      this.flush();
      return layers;
    };
    return { undo: () => apply('before'), redo: () => apply('after') };
  }
}
