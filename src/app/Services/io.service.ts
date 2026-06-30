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
import { ProjectService } from './ProjectService/project.service';

@Injectable({
  providedIn: 'root',
})
export class IOService implements OnDestroy {
  public requestedReload = new Subject<boolean>();
  private destroy$ = new Subject<void>();
  private dirty = false;

  /** Debounced autosave: persist this many ms after the last edit. */
  private readonly autosaveDelayMs = 5000;
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private labelService: LabelsService,
    private sequenceService: SequenceService,
    private canvasManagerService: CanvasManagerService,
    private stateManagerService: StateManagerService,
    private projectService: ProjectService,
    private vectorEditor: VectorEditorService
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

  public isDirty(): boolean {
    return this.dirty;
  }

  /** (Re)arm the debounced autosave after an edit. */
  private scheduleAutosave(): void {
    this.cancelAutosave();
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.saveIfDirty();
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
      if (annotations.length > 0) {
        const dataUrls: string[] = annotations.map(
          (annotation) => `data:image/png;base64,${annotation.maskPngBase64}`
        );
        await this.canvasManagerService.loadAllCanvas(dataUrls);
      }

      this.dirty = false;
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
      const width = this.stateManagerService.width;
      const height = this.stateManagerService.height;
      const isInstanceSeg = this.projectService.isInstanceSegmentation();

      for (let i = 0; i < labels.length; i++) {
        const canvas = this.canvasManagerService.labelCanvas[i];
        const ctx = this.canvasManagerService.canvasCtx[i];

        if (!canvas || !ctx) {
          continue;
        }

        // Find label ID from database (match by name)
        const labelId = await this.getLabelIdByName(labels[i].label);
        if (labelId === null) {
          console.warn(`Label not found in database: ${labels[i].label}`);
          continue;
        }

        if (isInstanceSeg) {
          // Get full RGBA data
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          await api.saveAnnotation(
            frame.id,
            labels[i].id,
            new Uint8Array(imageData.data),
            'Png'
          );
        } else {
          // Get alpha channel only
          const maskData = this.extractMaskData(
            ctx,
            canvas.width,
            canvas.height
          );

          await api.saveAnnotation(frame.id, labels[i].id, maskData, 'Rle');
        }

        // const annotation: AnnotationSave = {
        //   label_id: labelId,
        //   mask_data:
        //   width: canvas.width,
        //   height: canvas.height,
        // };
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

  // ==========================================
  // Private Helpers
  // ==========================================

  /**
   * Extract alpha channel as mask data from canvas.
   */
  private extractMaskData(
    ctx: OffscreenCanvasRenderingContext2D,
    width: number,
    height: number
  ): Uint8Array {
    const imageData = ctx.getImageData(0, 0, width, height);
    const mask = new Uint8Array(width * height);

    for (let i = 0; i < mask.length; i++) {
      mask[i] = imageData.data[i * 4 + 3]; // Alpha channel
    }

    return mask;
  }

  /**
   * Check if mask has any content.
   */
  private hasMaskContent(mask: Uint8Array): boolean {
    return mask.some((v) => v > 0);
  }

  /**
   * Get label ID from database by name.
   */
  private async getLabelIdByName(name: string): Promise<number | null> {
    try {
      const labels = await api.listLabels();
      const found = labels.find((l) => l.name === name);
      return found?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Convert blob to data URL.
   */
  private blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
}
