import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

// Services
import { LabelsService } from './Labels/labels.service';
import { SequenceService } from './sequence.service';
import { CanvasManagerService } from '../Components/pages/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../Components/pages/editor/drawable-canvas/service/state-manager.service';
import { VectorEditorService } from '../Components/pages/editor/drawable-canvas/service/vector-editor.service';

import { api } from '../lib/api';
import { NotificationService } from './notification.service';

@Injectable({
  providedIn: 'root',
})
export class IOService implements OnDestroy {
  public requestedReload = new Subject<boolean>();
  /** Emits after a frame's masks have been loaded into the canvas manager, so
   *  UI derived from mask contents (e.g. the instance picker) can refresh. */
  public readonly loaded$ = new Subject<void>();
  private destroy$ = new Subject<void>();
  private dirty = false;
  /** Label-layer indices changed since the last save (see markLabelDirty). */
  private readonly dirtyLabels = new Set<number>();

  /** Debounced autosave: persist this many ms after the last edit. */
  private readonly autosaveDelayMs = 5000;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private labelService: LabelsService,
    private sequenceService: SequenceService,
    private canvasManagerService: CanvasManagerService,
    private stateManagerService: StateManagerService,
    private vectorEditor: VectorEditorService,
    private notifications: NotificationService
  ) {
    // Vector edits flow back here so the same dirty flag / autosave covers them.
    this.vectorEditor.changed$.subscribe(() => this.markDirty());
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
   * Load annotations for the current frame from SQLite.
   */
  public async load(): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame) {
      return;
    }

    try {
      // Vector shapes are independent of the raster masks, so load them even
      // when a frame has no raster annotations.
      await this.loadVectors(frame.id);

      const annotations = await api.loadAnnotations(frame.id);
      const labels = this.labelService.listSegmentationLabels;

      this.canvasManagerService.clearAllMasks();
      for (const annotation of annotations) {
        const index = labels.findIndex((l) => l.id === annotation.labelId);
        if (index < 0) continue;
        this.canvasManagerService.setMask(index, base64ToUint8(annotation.maskBase64));
      }
      this.stateManagerService.recomputeCanvasSum = true;

      this.dirty = false;
      this.dirtyLabels.clear();
      this.loaded$.next();
    } catch (error) {
      console.error('Failed to load annotations:', error);
      throw error;
    }
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
      }

      await this.saveVectors(frame.id);

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
