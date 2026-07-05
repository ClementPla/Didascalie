import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { StateManagerService } from './state-manager.service';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { EditorService } from '../../services/editor.service';
import { BboxManagerService } from './bbox-manager.service';
import { CombinedLabel } from '../../../../../Core/interface';
import { WebGPUCanvasCompositorService } from './web-gpucanvas-compositor.service';
import { ZoomPanService } from './zoom-pan.service';
import { RenderStatsService } from '../../../../Utils/fps-display/render-stats.service';
import { buildLabelPalette } from '../../../../../Core/misc/colors';
import { connectedComponentBoxes, unionPresence } from '../../../../../Core/misc/label-ops';

/**
 * Owns the per-label pixel data as `Uint8Array` masks (0 = absent, 1 = present
 * for semantic labels, 1..255 = instance id) and composites them into the
 * displayed RGBA `combinedCanvas` via per-label colour palettes. Colour lives
 * only in the palette, so recolouring a label is a palette rebuild plus a
 * recomposite — the mask pixels never change.
 */
@Injectable({
  providedIn: 'root',
})
export class CanvasManagerService {
  /** One value mask per segmentation label, row-major, `width*height`. */
  labelMasks: Uint8Array[] = [];
  /** One 256-entry RGBA lookup table per label (value -> display colour). */
  palettes: Uint8Array[] = [];

  combinedCanvas: OffscreenCanvas;
  combinedCtx: OffscreenCanvasRenderingContext2D;

  /** Scratch canvas the drawing tools rasterize the in-progress stroke onto. */
  bufferCanvas: OffscreenCanvas;
  bufferCtx: OffscreenCanvasRenderingContext2D;

  requestRedraw: Subject<boolean> = new Subject<boolean>();
  private useWebGPU = false;

  constructor(
    private stateService: StateManagerService,
    private labelService: LabelsService,
    private editorService: EditorService,
    private bboxManager: BboxManagerService,
    private webgpuCompositor: WebGPUCanvasCompositorService,
    private zoomPan: ZoomPanService,
    private renderStats: RenderStatsService
  ) {
    this.initializeWebGPU();
  }

  private async initializeWebGPU(): Promise<void> {
    this.useWebGPU = await this.webgpuCompositor.initialize();
    console.log(
      `Using ${this.useWebGPU ? 'WebGPU' : 'CPU'} for canvas composition`
    );
  }

  // ==========================================
  // Palettes
  // ==========================================

  /** Recompute every label's colour LUT from the current label definitions. */
  rebuildPalettes() {
    this.palettes = this.labelService.listSegmentationLabels.map((label) =>
      buildLabelPalette(label.color, label.shades)
    );
  }

  // ==========================================
  // Composition
  // ==========================================

  async computeCombinedCanvas() {
    const t0 = performance.now();
    this.bboxManager.clear();

    if (this.useWebGPU && this.editorService.webGPURendering) {
      this.renderStats.compositeBackend = 'WebGPU';
      await this.computeCombinedCanvasGPU();
    } else {
      this.renderStats.compositeBackend = 'CPU';
      this.computeCombinedCanvasCPU();
    }

    if (this.editorService.showBoundingBox) {
      this.computeBoundingBoxes();
    }
    this.renderStats.recordComposite(performance.now() - t0);
  }

  private computeBoundingBoxes() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const labels = this.labelService.listSegmentationLabels;

    if (this.editorService.labelledCombinedBoundingBox) {
      const visible = this.labelMasks.filter((_, i) => labels[i]?.isVisible);
      const union = unionPresence(visible, w, h);
      this.bboxManager.addBboxes(connectedComponentBoxes(union, w, h), CombinedLabel);
    } else {
      this.labelMasks.forEach((mask, index) => {
        if (!labels[index]?.isVisible) return;
        this.bboxManager.addBboxes(connectedComponentBoxes(mask, w, h), labels[index]);
      });
    }
  }

  private async computeCombinedCanvasGPU() {
    const width = this.stateService.width;
    const height = this.stateService.height;
    try {
      const visibility = this.labelService.listSegmentationLabels.map((l) => l.isVisible);
      const imageData = await this.webgpuCompositor.compositeMasks(
        this.labelMasks,
        this.palettes,
        visibility,
        width,
        height,
        this.editorService.edgesOnly
      );
      this.combinedCtx.putImageData(imageData, 0, 0);
    } catch (error) {
      console.error('WebGPU composition failed, falling back to CPU:', error);
      this.computeCombinedCanvasCPU();
    }
  }

  computeCombinedCanvasCPU() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const labels = this.labelService.listSegmentationLabels;

    const img = this.combinedCtx.createImageData(w, h);
    const data = img.data;

    // Draw labels in order; later labels paint over earlier ones (masks are
    // disjoint in practice, so this is just a value -> colour write).
    for (let li = 0; li < this.labelMasks.length; li++) {
      if (!labels[li]?.isVisible) continue;
      const mask = this.labelMasks[li];
      const pal = this.palettes[li];
      if (!mask || !pal) continue;

      for (let i = 0; i < mask.length; i++) {
        const v = mask[i];
        if (v === 0) continue;
        const o = i * 4;
        const p = v * 4;
        data[o] = pal[p];
        data[o + 1] = pal[p + 1];
        data[o + 2] = pal[p + 2];
        data[o + 3] = pal[p + 3];
      }
    }

    this.combinedCtx.putImageData(img, 0, 0);

    if (this.editorService.edgesOnly) {
      this.extractEdges(this.combinedCtx, this.zoomPan.getScale());
    }
  }

  private extractEdges(
    ctx: OffscreenCanvasRenderingContext2D,
    scale: number
  ): void {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const imgData = ctx.getImageData(0, 0, w, h);
    const src = imgData.data;
    const src32 = new Uint32Array(src.buffer);
    const out = new Uint8ClampedArray(src.length);
    const stride = w * 4;

    // Target ~2px on screen -> need ceil(2/scale) px in image space.
    const radius = Math.min(Math.max(1, Math.ceil(2 / scale)), 10);

    // A labelled pixel is an edge when a neighbour has a *different colour* —
    // which covers label↔background AND label↔label / instance↔instance
    // boundaries, so an object enclosed by another still gets its own outline.
    // Background pixels are skipped, so the outline never bleeds onto them.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * stride + x * 4;
        if (src[i + 3] === 0) continue;
        const center = src32[y * w + x];

        let isEdge = false;
        for (let dy = -radius; dy <= radius && !isEdge; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) {
            isEdge = true;
            break;
          }
          for (let dx = -radius; dx <= radius && !isEdge; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) {
              isEdge = true;
              break;
            }
            if (src32[ny * w + nx] !== center) isEdge = true;
          }
        }

        if (isEdge) {
          out[i] = src[i];
          out[i + 1] = src[i + 1];
          out[i + 2] = src[i + 2];
          out[i + 3] = 255;
        }
      }
    }

    ctx.putImageData(new ImageData(out, w, h), 0, 0);
  }

  // ==========================================
  // Allocation / lifecycle
  // ==========================================

  private ensureAuxCanvases(width: number, height: number) {
    if (!this.combinedCanvas) {
      this.combinedCanvas = new OffscreenCanvas(width, height);
      this.combinedCtx = this.combinedCanvas.getContext('2d', {
        alpha: true,
        desynchronized: true,
      })!;
    }
    if (!this.bufferCanvas) {
      this.bufferCanvas = new OffscreenCanvas(width, height);
      this.bufferCtx = this.bufferCanvas.getContext('2d', { alpha: true })!;
    }
    for (const canvas of [this.combinedCanvas, this.bufferCanvas]) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }
  }

  async updateCanvasesDimensions() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const nLabels = this.labelService.listSegmentationLabels.length;

    this.ensureAuxCanvases(w, h);

    const needsRealloc =
      this.labelMasks.length !== nLabels ||
      (this.labelMasks[0]?.length ?? 0) !== w * h;
    if (needsRealloc) {
      this.labelMasks = Array.from({ length: nLabels }, () => new Uint8Array(w * h));
    }
    this.rebuildPalettes();

    await this.webgpuCompositor.prepareResources(w, h, Math.max(1, nLabels));
  }

  // ==========================================
  // Mask access / mutation
  // ==========================================

  getActiveIndex() {
    return this.labelService.getActiveIndex();
  }

  getActiveMask(): Uint8Array {
    return this.labelMasks[this.getActiveIndex()];
  }

  getAllMasks(): Uint8Array[] {
    return this.labelMasks;
  }

  /** Replace a label's mask contents from raw uint8 values (e.g. on load). */
  setMask(index: number, values: Uint8Array) {
    const mask = this.labelMasks[index];
    if (mask && mask.length === values.length) {
      mask.set(values);
    } else if (mask) {
      // Dimension mismatch (stale image): copy what fits.
      mask.fill(0);
      mask.set(values.subarray(0, Math.min(mask.length, values.length)));
    }
  }

  clearMaskAtIndex(index: number) {
    this.labelMasks[index]?.fill(0);
  }

  clearAllMasks() {
    this.labelMasks.forEach((mask) => mask.fill(0));
    this.resetCombinedCanvas();
    this.bboxManager.clear();
  }

  resetCombinedCanvas() {
    this.combinedCtx.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  getBufferCanvas() {
    return this.bufferCanvas;
  }
  getBufferCtx() {
    return this.bufferCtx;
  }
  getCombinedCtx() {
    return this.combinedCtx;
  }
  getCombinedCanvas() {
    return this.combinedCanvas;
  }

  clearCanvas(ctx: OffscreenCanvasRenderingContext2D) {
    ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  public ensurePixelPerfectDrawing(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ) {
    ctx.imageSmoothingEnabled = false;
    // @ts-ignore - vendor-prefixed variants on some browsers
    ctx.mozImageSmoothingEnabled = false;
    // @ts-ignore
    ctx.msImageSmoothingEnabled = false;
    if (ctx.canvas instanceof HTMLCanvasElement) {
      ctx.canvas.style.imageRendering = 'pixelated';
    }
    const transform = ctx.getTransform();
    if (transform) {
      const roundedE = Math.round(transform.e);
      const roundedF = Math.round(transform.f);
      if (transform.e !== roundedE || transform.f !== roundedF) {
        ctx.setTransform(
          transform.a,
          transform.b,
          transform.c,
          transform.d,
          roundedE,
          roundedF
        );
      }
    }
  }
}
