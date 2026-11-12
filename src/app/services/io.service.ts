import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subject } from 'rxjs';

import { LabelsService } from './labels/labels.service';
import { SequenceService } from './sequence.service';
import { CanvasManagerService } from '../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../features/editor/drawable-canvas/service/state-manager.service';
import { VectorEditorService } from '../features/editor/drawable-canvas/service/vector-editor.service';

import { api } from '../lib/api';
import { NotificationService } from './notification.service';
import { MaskVolumeService } from './mask-volume.service';
import { ProjectScoped } from '../core/project-scoped';
import { base64ToUint8 } from '../core/misc/base64';
import { decodeRle8 } from '../lib/rle8';

/**
 * Loading and saving of a frame's annotations.
 *
 * A global service that depends on the editor's canvas services, because what
 * it saves is the in-memory canvas state.
 */
@Injectable({
  providedIn: 'root',
})
export class IOService implements OnDestroy, ProjectScoped {
  private labelService = inject(LabelsService);
  private sequenceService = inject(SequenceService);
  private canvasManagerService = inject(CanvasManagerService);
  private stateManagerService = inject(StateManagerService);
  private vectorEditor = inject(VectorEditorService);
  private notifications = inject(NotificationService);
  private volume = inject(MaskVolumeService);

  public requestedReload = new Subject<boolean>();
  /** A frame's masks were loaded into the canvas manager. */
  public readonly loaded$ = new Subject<void>();
  private destroy$ = new Subject<void>();
  private dirty = false;
  /** Label-layer indices changed since the last save (see markLabelDirty). */
  private readonly dirtyLabels = new Set<number>();
  /** Frame whose masks the canvas manager currently holds (set by `load`). */
  private loadedFrameId: number | null = null;

  /** Debounced autosave: persist this many ms after the last edit. */
  private readonly autosaveDelayMs = 5000;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Vector edits use the same dirty flag and autosave.
    this.vectorEditor.changed$.subscribe(() => this.markDirty());

    // 3D mode. Before the volume drops its buffers, the open frame's masks become
    // owned copies. Once it is resident, they move into their slice.
    this.volume.released$.subscribe(() => this.canvasManagerService.detachMasks());
    this.volume.ready$.subscribe(() => this.adoptVolumeSlice());
  }

  ngOnDestroy(): void {
    this.cancelAutosave();
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  public requestReloadEvent(): void {
    this.requestedReload.next(true);
  }

  public markDirty(): void {
    this.dirty = true;
    this.scheduleAutosave();
  }

  /** Record that a label layer changed, so that `save()` sends only the masks
   *  that did: a full mask is large. */
  public markLabelDirty(index: number): void {
    if (index >= 0) this.dirtyLabels.add(index);
    const frameId = this.loadedFrameId;
    if (frameId != null && index >= 0) this.volume.markEdited(frameId, index);
    this.markDirty();
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = setTimeout(async () => {
      this.autosaveTimer = null;
      if (!this.dirty) return;
      if (await this.save()) {
        this.notifications.notify({
          severity: 'secondary',
          summary: 'Saved',
          life: 1500,
        });
      }
    }, this.autosaveDelayMs);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer) {
      clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  /** Forget what is queued for saving, without writing it. For callers about
   *  to delete the same annotations: a pending autosave would restore them. */
  public discardPendingSave(): void {
    this.cancelAutosave();
    this.dirty = false;
    this.dirtyLabels.clear();
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.discardPendingSave();
  }

  public async load(): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame) {
      return;
    }

    // The canvas still holds the previous frame: write its changes before they
    // are cleared. Navigation saves first; this covers every other way here.
    if (this.dirty || this.dirtyLabels.size > 0) {
      if (!(await this.saveIfDirty())) {
        console.error(`Unsaved changes of frame ${this.loadedFrameId} were dropped`);
      }
    } else {
      await this.saveChain;
    }

    try {
      // Until this load completes, a volume becoming ready must not adopt the
      // canvas's masks.
      this.loadedFrameId = null;

      await this.loadVectors(frame.id);

      // 3D mode: the masks are already resident as slices of the volume.
      const slices = this.volume.slicesFor(frame.id);
      if (slices) {
        this.canvasManagerService.bindMasks(slices);
      } else {
        // A borrowed slice must not be cleared or overwritten with another frame's
        // data. Cleared before the IPC: a failed load must not leave the previous
        // frame's masks showing.
        this.canvasManagerService.detachMasks();
        this.canvasManagerService.clearAllMasks();
        const annotations = await api.loadAnnotations(frame.id);
        const labels = this.labelService.listSegmentationLabels;

        for (const annotation of annotations) {
          const index = labels.findIndex((l) => l.id === annotation.labelId);
          if (index < 0) continue;
          const rle8 = base64ToUint8(annotation.rle8Base64);
          this.canvasManagerService.setMask(index, decodeRle8(rle8, annotation.width * annotation.height));
        }
        // The label list changed since the volume was built: rebuild it.
        if (this.volume.status() === 'ready' && !this.volume.matchesLabels()) {
          this.volume.reload();
        }
      }
      this.loadedFrameId = frame.id;
      // The volume may have become ready while this frame was loading.
      if (!slices) this.adoptVolumeSlice();
      this.stateManagerService.recomputeCanvasSum = true;

      this.dirty = false;
      this.dirtyLabels.clear();
      this.loaded$.next();
    } catch (error) {
      console.error('Failed to load annotations:', error);
      throw error;
    }
  }

  /** The mask volume just became resident: if the canvas still shows the frame
   *  it last loaded, copy its masks into that slice and bind the layers to it. */
  private adoptVolumeSlice(): void {
    const frameId = this.sequenceService.currentFrame()?.id;
    if (frameId == null || frameId !== this.loadedFrameId) return;
    const slices = this.volume.slicesFor(frameId);
    const current = this.canvasManagerService.labelMasks;
    if (!slices || slices.some((s, i) => s.length !== current[i]?.length)) return;
    slices.forEach((s, i) => s.set(current[i]));
    this.canvasManagerService.bindMasks(slices);
  }

  private async loadVectors(frameId: number): Promise<void> {
    try {
      const rows = await api.loadVectorAnnotations(frameId);
      this.vectorEditor.setShapes(rows.flatMap((r) => r.shapes));
    } catch (error) {
      console.error('Failed to load vector annotations:', error);
      this.vectorEditor.clear();
    }
  }

  /**
   * Write the loaded frame's changes. Saves run one at a time; each writes to
   * the frame the canvas holds (not the frame navigation is moving to), and a
   * failed save keeps its changes queued and says so.
   */
  public save(): Promise<boolean> {
    const run = this.saveChain.then(() => this.saveNow());
    this.saveChain = run.catch(() => undefined);
    return run;
  }

  /** Save if anything changed; true when nothing is left unsaved. */
  public async saveIfDirty(): Promise<boolean> {
    // A save in flight may have taken the changes: wait for its outcome.
    await this.saveChain;
    return this.dirty ? this.save() : true;
  }

  /** The saves queued one after the other (see `save`). */
  private saveChain: Promise<unknown> = Promise.resolve();

  private async saveNow(): Promise<boolean> {
    const frameId = this.loadedFrameId;
    if (frameId == null) return !this.dirty;

    // What to write, taken now: edits made while it is written are queued
    // again by markLabelDirty for the next save.
    const labels = this.labelService.listSegmentationLabels;
    const dirty = [...this.dirtyLabels];
    const shapes = this.vectorEditor.shapesByLabel();
    this.dirtyLabels.clear();
    this.dirty = false;
    this.cancelAutosave();

    try {
      for (const i of dirty) {
        const mask = this.canvasManagerService.labelMasks[i];
        if (!mask || !labels[i]) continue;
        // Encoded before the call returns: later edits do not reach this write.
        await api.saveAnnotation(frameId, labels[i].id, mask);
        this.volume.syncSaved(frameId, labels[i].id, mask);
      }
      for (const label of labels) {
        await api.saveVectorAnnotations(frameId, label.id, shapes.get(label.id) ?? []);
      }
      // 3D mode: other slices written through the volume (projection view).
      await this.volume.saveDirty();
      return true;
    } catch (error) {
      console.error('Failed to save annotations:', error);
      // Keep the changes queued, unless the canvas has moved on (load waits for
      // saves, so it should not have).
      if (this.loadedFrameId === frameId) {
        dirty.forEach((i) => this.dirtyLabels.add(i));
        this.dirty = true;
      }
      this.notifications.error(
        'Could not save the annotations',
        `${error instanceof Error ? error.message : String(error)}. They are kept: the next save tries again.`,
      );
      return false;
    }
  }

}
