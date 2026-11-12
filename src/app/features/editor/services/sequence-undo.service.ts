import { Injectable, effect, inject } from '@angular/core';
import { api } from '../../../lib/api';
import { IOService } from '../../../services/io.service';
import { SequenceService } from '../../../services/sequence.service';
import { MaskVolumeService } from '../../../services/mask-volume.service';
import { NotificationService } from '../../../services/notification.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { ProjectScoped } from '../../../core/project-scoped';
import { UndoRedoService } from '../drawable-canvas/service/undo-redo.service';
import { CanvasManagerService } from '../drawable-canvas/service/canvas-manager.service';

const TAG = 'sequence';

/**
 * Undo and redo for operations that write many frames of the open sequence
 * (propagation, clearing it, Boolean on all frames).
 *
 * The project holds the truth: before the operation, the open frame is saved
 * and the frames' stored annotations are snapshotted (in Rust); after it, again.
 * Undo puts the first snapshot back, redo the second, as one step of the
 * editor's history from any frame. A frame edited since the operation is left
 * alone. The history of these operations ends with the sequence.
 */
@Injectable({ providedIn: 'root' })
export class SequenceUndoService implements ProjectScoped {
  private undoRedo = inject(UndoRedoService);
  private io = inject(IOService);
  private sequence = inject(SequenceService);
  private volume = inject(MaskVolumeService);
  private notifications = inject(NotificationService);
  private labels = inject(LabelsService);
  private canvasManager = inject(CanvasManagerService);

  /** Snapshot ids held for the open sequence. */
  private held: number[] = [];

  constructor() {
    // Another sequence: these operations can no longer be undone.
    let sequenceId: number | null = null;
    effect(() => {
      const id = this.sequence.currentSequence()?.id ?? null;
      if (id !== sequenceId) {
        sequenceId = id;
        this.forget();
      }
    });
  }

  /**
   * Run `operation`, which writes `frameIds` (the open frame may be among
   * them), as one undoable step named `name`. The operation must leave the
   * project up to date, the open frame included.
   */
  async record<T>(name: string, frameIds: number[], operation: () => Promise<T>): Promise<T> {
    await this.io.saveIfDirty();
    const before = await api.snapshotTake(frameIds);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      void api.snapshotDrop([before]);
      throw error;
    }
    await this.io.saveIfDirty();
    const after = await api.snapshotTake(frameIds);
    this.held.push(before, after);

    const openId = this.sequence.currentFrame()?.id;
    this.undoRedo.pushExternal(
      {
        tag: TAG,
        undo: () => this.restore(name, before, after, 'undo'),
        redo: () => this.restore(name, after, before, 'redo'),
      },
      openId != null && frameIds.includes(openId) ? this.allLayers() : [],
    );
    return result;
  }

  /** Put `target` back; null when the snapshot is gone (step dropped). */
  private async restore(
    name: string,
    target: number,
    expected: number,
    direction: 'undo' | 'redo',
  ): Promise<number[] | null> {
    // Edits on the open frame count as "since": they must be in the project.
    await this.io.saveIfDirty();
    const report = await api.snapshotRestore(target, expected);
    if (report.gone) {
      this.notifications.warn(`Cannot ${direction} ${name}`, 'Its saved state is no longer kept.');
      return null;
    }

    const verb = direction === 'undo' ? 'Undid' : 'Redid';
    const restored = report.restored.length;
    const kept = report.kept.length;
    const frames = (n: number) => `${n} frame${n === 1 ? '' : 's'}`;
    const detail = kept
      ? `${frames(restored)} restored; ${frames(kept)} edited since kept as they are.`
      : `${frames(restored)} restored.`;
    if (kept) this.notifications.warn(`${verb} ${name}`, detail);
    else this.notifications.success(`${verb} ${name}`, detail);

    if (restored === 0) return [];
    this.volume.reload();
    const openId = this.sequence.currentFrame()?.id;
    if (openId == null || !report.restored.includes(openId)) return [];
    // The open frame changed in the project: show it.
    await this.io.load();
    this.canvasManager.requestRedraw.next(true);
    return this.allLayers();
  }

  private allLayers(): number[] {
    return this.labels.listSegmentationLabels.map((_, i) => i);
  }

  private forget(): void {
    this.undoRedo.dropExternals(TAG);
    if (this.held.length) void api.snapshotDrop(this.held).catch(() => {});
    this.held = [];
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.held = [];
    this.undoRedo.dropExternals(TAG);
    void api.snapshotClear().catch(() => {});
  }
}
