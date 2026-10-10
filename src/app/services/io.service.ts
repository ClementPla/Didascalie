import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

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
    const frameId = this.sequenceService.currentFrame()?.id;
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
          this.canvasManagerService.setMask(index, base64ToUint8(annotation.maskBase64));
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

  /** Persist vector shapes, once per label, so that a label left without
   *  shapes has its row cleared. */
  private async saveVectors(frameId: number): Promise<void> {
    const byLabel = this.vectorEditor.shapesByLabel();
    for (const label of this.labelService.listSegmentationLabels) {
      await api.saveVectorAnnotations(
        frameId,
        label.id,
        byLabel.get(label.id) ?? []
      );
    }
  }

  public async save(): Promise<boolean> {
    const frame = this.sequenceService.currentFrame();
    if (!frame) {
      return false;
    }

    try {
      const labels = this.labelService.listSegmentationLabels;

      // Only the masks that changed since the last save.
      const dirty = [...this.dirtyLabels];
      this.dirtyLabels.clear();
      for (const i of dirty) {
        const mask = this.canvasManagerService.labelMasks[i];
        if (!mask || !labels[i]) continue;
        await api.saveAnnotation(frame.id, labels[i].id, mask);
        this.volume.syncSaved(frame.id, labels[i].id, mask);
      }

      await this.saveVectors(frame.id);
      // 3D mode: other slices written through the volume (projection view).
      await this.volume.saveDirty();

      this.dirty = false;
      this.cancelAutosave();
      return true;
    } catch (error) {
      console.error('Failed to save annotations:', error);
      return false;
    }
  }

  public async saveIfDirty(): Promise<boolean> {
    if (this.dirty) {
      return this.save();
    }
    return true;
  }

  public async deleteAnnotation(labelId: number): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame) {
      return;
    }

    await invoke('delete_annotation', {
      frameId: frame.id,
      labelId,
    });
  }

}
