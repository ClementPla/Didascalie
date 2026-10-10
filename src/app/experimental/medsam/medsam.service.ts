import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { binarizeArray } from '../../core/misc/binarize';
import { applyResultMask } from '../../core/misc/label-ops';
import { CanvasManagerService } from '../../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../../features/editor/drawable-canvas/service/state-manager.service';
import { ImageAdjustmentService } from '../../features/editor/drawable-canvas/service/image-adjustment/image-adjustment.service';
import { LabelsService } from '../../services/labels/labels.service';
import { ProjectService } from '../../services/project/project.service';

/** Refine a coarse stroke into a mask with the bundled SAM-style model
 *  (Rust `mask_sam_segment`). */
@Injectable({ providedIn: 'root' })
export class MedsamService {
  private canvasManagerService = inject(CanvasManagerService);
  private stateService = inject(StateManagerService);
  private imageProcessingService = inject(ImageAdjustmentService);
  private labelService = inject(LabelsService);
  private projectService = inject(ProjectService);

  /** Confidence a pixel needs before the model keeps it. */
  public threshold = 0.5;

  /** Whether the Rust side holds encoder features for the current image. */
  private featuresExtracted = false;

  async refineStroke(): Promise<void> {
    const w = this.stateService.width;
    const h = this.stateService.height;

    // SAM reads the full image and stroke buffer, which large images (windowed
    // composite) do not have.
    if (this.canvasManagerService.usesViewportComposite) {
      console.warn('SAM post-process is unavailable for large images.');
      return;
    }

    const bufferCtx = this.canvasManagerService.getBufferCtx();
    const coarseMask = binarizeArray(bufferCtx.getImageData(0, 0, w, h).data).data;

    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;
    const imgCtx = canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
    if (!imgCtx) return;
    const imgData = imgCtx.getImageData(0, 0, w, h).data;

    // Encoder features are extracted on the first stroke of an image.
    const result = await invoke<ArrayBufferLike>('mask_sam_segment', {
      coarseMask,
      image: this.featuresExtracted ? [] : imgData.buffer,
      threshold: this.threshold,
      width: w,
      height: h,
      extractFeatures: !this.featuresExtracted,
    });
    this.featuresExtracted = true;

    const mask = this.canvasManagerService.getActiveMask();
    if (mask) applyResultMask(mask, new Uint8Array(result), this.labelService.paintValue(this.projectService.isInstanceSegmentation()));
  }

  onImageLoaded(): void {
    this.featuresExtracted = false;
  }
}
