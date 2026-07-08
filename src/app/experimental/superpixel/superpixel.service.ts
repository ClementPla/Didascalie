import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { applyResultMask } from '../../Core/misc/label-ops';
import { CanvasManagerService } from '../../Components/pages/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../../Components/pages/editor/drawable-canvas/service/state-manager.service';
import { ImageAdjustmentService } from '../../Components/pages/editor/drawable-canvas/service/image-adjustment/image-adjustment.service';
import { LabelsService } from '../../Services/Labels/labels.service';

/**
 * Experimental: snap brush strokes to superpixel boundaries
 * (Rust `superpixel_refine` / `superpixel_overlay` commands).
 * Owns all superpixel settings and cached state.
 */
@Injectable({ providedIn: 'root' })
export class SuperpixelService {
  /** Approximate number of superpixels in the map. */
  public count = 2000;
  /** CIEDE2000 similarity tolerance between a superpixel and the stroke. */
  public threshold = 10.0;
  /** Minimum fraction of a superpixel the stroke must cover. */
  public minOverlap = 0.15;
  /** Overlay the superpixel boundaries on the canvas. */
  public showBoundaries = false;

  /** Whether the Rust side holds a superpixel map for the current image. */
  private mapComputed = false;
  /** Cached boundary overlay at image-native resolution. */
  private overlayCanvas: OffscreenCanvas | null = null;

  constructor(
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private imageProcessingService: ImageAdjustmentService,
    private labelService: LabelsService
  ) {}

  /** Refine the stroke in the buffer canvas: keep only the touched
   *  superpixels that match the dominant color under the stroke. */
  async refineStroke(): Promise<void> {
    const bufferCtx = this.canvasManagerService.getBufferCtx();
    const rect = {
      x: 0,
      y: 0,
      width: this.stateService.width,
      height: this.stateService.height,
    };

    // The buffer holds the brush stroke; the Rust side reads its alpha.
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

    // Compute the superpixel map on the first stroke of an image, reuse after
    // (mirrors the SAM feature-extraction flag). The command returns an RGBA
    // mask (white/transparent), like flood_fill.
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

  /** Invalidate the cached superpixel map/overlay (e.g. when the target count
   *  changes) so the next stroke or overlay refresh recomputes it. */
  invalidate(): void {
    this.mapComputed = false;
    this.overlayCanvas = null;
  }

  /** The overlay to draw on the canvas, or null when hidden/not computed. */
  visibleOverlay(): OffscreenCanvas | null {
    return this.showBoundaries ? this.overlayCanvas : null;
  }

  /** Fetch (building the map on demand) and cache the superpixel boundary
   *  overlay, then request a redraw. Clears the overlay when the toggle is off. */
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

  /** The superpixel count changed: drop the cached map and, if the overlay is
   *  visible, recompute it with the new granularity. */
  onCountChanged(): void {
    this.invalidate();
    if (this.showBoundaries) {
      void this.updateOverlay();
    }
  }

  /** A new image was loaded: the map belongs to the previous image. */
  onImageLoaded(): void {
    this.invalidate();
    if (this.showBoundaries) {
      // Rebuild the overlay for the newly loaded image.
      void this.updateOverlay();
    }
  }

  /** Experimental features were switched off: hide the overlay. */
  onFeatureDisabled(): void {
    this.showBoundaries = false;
    this.overlayCanvas = null;
    this.canvasManagerService.requestRedraw.next(true);
  }
}
