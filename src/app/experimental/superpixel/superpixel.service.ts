import { Injectable, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { applyResultMask } from '../../core/misc/label-ops';
import { CanvasManagerService } from '../../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../../features/editor/drawable-canvas/service/state-manager.service';
import { ImageAdjustmentService } from '../../features/editor/drawable-canvas/service/image-adjustment/image-adjustment.service';
import { LabelsService } from '../../services/labels/labels.service';

/** Snap brush strokes to superpixel boundaries (Rust `superpixel_refine` /
 *  `superpixel_overlay`). */
@Injectable({ providedIn: 'root' })
export class SuperpixelService {
  private canvasManagerService = inject(CanvasManagerService);
  private stateService = inject(StateManagerService);
  private imageProcessingService = inject(ImageAdjustmentService);
  private labelService = inject(LabelsService);

  /** Approximate number of superpixels in the map. */
  public count = 2000;
  /** CIEDE2000 similarity tolerance between a superpixel and the stroke. */
  public threshold = 10.0;
  /** Minimum fraction of a superpixel the stroke must cover. */
  public minOverlap = 0.15;
  public showBoundaries = false;

  /** Whether the Rust side holds a superpixel map for the current image. */
  private mapComputed = false;
  /** Cached boundary overlay at image-native resolution. */
  private overlayCanvas: OffscreenCanvas | null = null;

  /** Keep only the touched superpixels that match the dominant colour under
   *  the stroke. */
  async refineStroke(): Promise<void> {
    const bufferCtx = this.canvasManagerService.getBufferCtx();
    const rect = {
      x: 0,
      y: 0,
      width: this.stateService.width,
      height: this.stateService.height,
    };

    const maskData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;

    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;
    const imgData = (canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null)!.getImageData(rect.x, rect.y, rect.width, rect.height).data;

    // The map is computed on the first stroke of an image.
    const result = await invoke<ArrayBufferLike>('superpixel_refine', {
      image: this.mapComputed ? [] : imgData.buffer,
      brush: maskData.buffer,
      width: rect.width,
      height: rect.height,
      computeMap: !this.mapComputed,
      targetCount: this.count,
      similarityThreshold: this.threshold,
      minOverlapFraction: this.minOverlap,
    });
    this.mapComputed = true;

    const value = Math.min(
      255,
      Math.max(1, Math.round(this.labelService.activeSegInstance?.instance ?? 1))
    );
    const mask = this.canvasManagerService.getActiveMask();
    if (mask) {
      applyResultMask(mask, new Uint8Array(result), value);
      this.stateService.recomputeCanvasSum = true;
    }
  }

  /** Drop the cached map and overlay. */
  invalidate(): void {
    this.mapComputed = false;
    this.overlayCanvas = null;
  }

  visibleOverlay(): OffscreenCanvas | null {
    return this.showBoundaries ? this.overlayCanvas : null;
  }

  /** Fetch and cache the boundary overlay, building the map on demand. */
  async updateOverlay(): Promise<void> {
    if (!this.showBoundaries) {
      this.overlayCanvas = null;
      this.canvasManagerService.requestRedraw.next(true);
      return;
    }

    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;
    const width = this.stateService.width;
    const height = this.stateService.height;
    const imgData = (canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null)!.getImageData(0, 0, width, height).data;

    const overlay = await invoke<Uint8ClampedArray>('superpixel_overlay', {
      image: this.mapComputed ? [] : imgData.buffer,
      width,
      height,
      computeMap: !this.mapComputed,
      targetCount: this.count,
    });
    this.mapComputed = true;

    const off = new OffscreenCanvas(width, height);
    off
      .getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray(overlay), width, height),
        0,
        0
      );
    this.overlayCanvas = off;
    this.canvasManagerService.requestRedraw.next(true);
  }

  onCountChanged(): void {
    this.invalidate();
    if (this.showBoundaries) {
      void this.updateOverlay();
    }
  }

  onImageLoaded(): void {
    this.invalidate();
    if (this.showBoundaries) {
      void this.updateOverlay();
    }
  }

  onFeatureDisabled(): void {
    this.showBoundaries = false;
    this.overlayCanvas = null;
    this.canvasManagerService.requestRedraw.next(true);
  }
}
