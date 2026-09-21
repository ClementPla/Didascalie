import { Injectable, OnDestroy, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

// Services
import { LabelsService } from './labels/labels.service';
import { SequenceService } from './sequence.service';
import { CanvasManagerService } from '../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../features/editor/drawable-canvas/service/state-manager.service';
import { VectorEditorService } from '../features/editor/drawable-canvas/service/vector-editor.service';

import { api } from '../lib/api';
import { NotificationService } from './notification.service';
import { MaskVolumeService } from './mask-volume.service';
import { ProjectScoped } from '../core/project-scoped';

/**
 * Loading and saving of a frame's annotations.
 *
 * # Known layering wart
 *
 * This lives under `services/` because ten call sites treat it as app-global
 * (app startup, project close, propagation), yet it injects three services that
 * belong to the editor's canvas — `CanvasManagerService`, `StateManagerService`
 * and `VectorEditorService` — because the thing it saves *is* the in-memory
 * canvas state. So a global service depends on one page's internals, and
 * neither can move without the other.
 *
 * `PredictionService` had the same shape and was simply moved into
 * `drawable-canvas/service/`, since the editor toolbar was its only consumer.
 * That is not available here. Untangling this one means inverting the
 * dependency — the editor registering its canvas with an interface this service
 * owns — which is worth doing but is not a rename.
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
  /** Emits after a frame's masks have been loaded into the canvas manager, so
   *  UI derived from mask contents (e.g. the instance picker) can refresh. */
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
    // Vector edits flow back here so the same dirty flag / autosave covers them.
    this.vectorEditor.changed$.subscribe(() => this.markDirty());

    // 3D mode. The volume is about to drop its buffers: keep the open frame's
    // masks as owned copies. It just became resident: move the open frame's
    // masks (unsaved edits included) into their slice and edit it in place.
    this.volume.released$.subscribe(() => this.canvasManagerService.detachMasks());
    this.volume.ready$.subscribe(() => this.adoptVolumeSlice());
  }

  ngOnDestroy(): void {
    this.cancelAutosave();
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ==========================================
  // Public API
  // ==========================================

  public requestReloadEvent(): void {
    this.requestedReload.next(true);
  }

  public markDirty(): void {
    this.dirty = true;
    this.scheduleAutosave();
  }

  /**
   * Record that a label layer's pixels changed, so `save()` only ships the
   * masks that actually changed. Critical on large images: a full mask is huge
   * (~136 MB at 8k×17k), so re-sending every label per save froze the UI.
   */
  public markLabelDirty(index: number): void {
    if (index >= 0) this.dirtyLabels.add(index);
    const frameId = this.sequenceService.currentFrame()?.id;
    if (frameId != null && index >= 0) this.volume.markEdited(frameId, index);
    this.markDirty();
  }

  public isDirty(): boolean {
    return this.dirty;
  }

  /** (Re)arm the debounced autosave after an edit. */
  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = setTimeout(async () => {
      this.autosaveTimer = null;
      if (!this.dirty) return;
      // Only cue on a real persist — a brief, muted toast that fades quickly.
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

  /**
   * Forget everything queued for saving, without writing it.
   *
   * For callers that are about to delete the same annotations in the database:
   * autosave fires several seconds after the last edit, so a pending write
   * landing after the delete would put the frame straight back.
   */
  public discardPendingSave(): void {
    this.cancelAutosave();
    this.dirty = false;
    this.dirtyLabels.clear();
  }

  /**
   * @see ProjectScoped
   *
   * Dropping the queued save is the point: a timer armed against the old
   * project would otherwise fire after the switch and write its masks into
   * whichever frame is open by then.
   */
  resetForProject(): void {
    this.discardPendingSave();
  }

  /**
   * Load annotations for the current frame from SQLite.
   */
  public async load(): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame) {
      return;
    }

    try {
      // Until this load completes the canvas holds no frame's masks as such,
      // so a volume becoming ready meanwhile must not adopt them.
      this.loadedFrameId = null;

      // Vector shapes are independent of the raster masks, so load them even
      // when a frame has no raster annotations.
      await this.loadVectors(frame.id);

      // 3D mode: the masks are already resident as slices of the volume.
      const slices = this.volume.slicesFor(frame.id);
      if (slices) {
        this.canvasManagerService.bindMasks(slices);
      } else {
        // Never clear or overwrite a borrowed slice with another frame's data.
        // Clear before the IPC so a failed load never leaves the previous
        // frame's masks showing on this one.
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

  /**
   * The mask volume just became resident. If the canvas still shows the frame
   * it last loaded, copy its masks into that slice and bind the layers to it.
   * Mid-navigation (another frame is loading) there is nothing to adopt: the
   * next `load()` binds the new frame's slice.
   */
  private adoptVolumeSlice(): void {
    const frameId = this.sequenceService.currentFrame()?.id;
    if (frameId == null || frameId !== this.loadedFrameId) return;
    const slices = this.volume.slicesFor(frameId);
    const current = this.canvasManagerService.labelMasks;
    if (!slices || slices.some((s, i) => s.length !== current[i]?.length)) return;
    slices.forEach((s, i) => s.set(current[i]));
    this.canvasManagerService.bindMasks(slices);
  }

  /** Load this frame's vector shapes into the editor (best-effort). */
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
   * Persist vector shapes. Saves once per current label so a label whose shapes
   * were all removed has its row cleared (empty array deletes server-side).
   */
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

  /**
   * Save annotations for the current frame to SQLite.
   */
  public async save(): Promise<boolean> {
    const frame = this.sequenceService.currentFrame();
    if (!frame) {
      return false;
    }

    try {
      const labels = this.labelService.listSegmentationLabels;

      // Only persist masks that changed since the last save — a full mask is
      // huge on large images, so re-sending untouched labels froze the UI.
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

  /**
   * Save if there are unsaved changes.
   */
  public async saveIfDirty(): Promise<boolean> {
    if (this.dirty) {
      return this.save();
    }
    return true;
  }

  /**
   * Delete annotation for a specific label on current frame.
   */
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

/** Decode a base64 string into raw bytes (uint8 value mask). */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
