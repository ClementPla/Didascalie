import { Injectable, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { StateManagerService } from './state-manager.service';
import { LabelsService } from '../../../../services/labels/labels.service';
import { EditorService } from '../../services/editor.service';
import { BboxManagerService } from './bbox-manager.service';
import { CombinedLabel } from '../../../../core/interface';
import { WebGPUCanvasCompositorService } from './web-gpucanvas-compositor.service';
import { ZoomPanService } from './zoom-pan.service';
import { RenderStatsService } from '../../../../shared/fps-display/render-stats.service';
import { buildLabelPalette } from '../../../../core/misc/colors';
import {
  connectedComponentBoxes,
  connectedComponentBoxesDownsampled,
  downsamplePresence,
  unionPresence,
} from '../../../../core/misc/label-ops';
import { ProjectScoped } from '../../../../core/project-scoped';
import {
  MAX_OUTLINE_RADIUS,
  OutlineScratch,
  OutlineStyle,
  paintLayerOutlined,
} from './outline-raster';

/** Longest side (px) past which the label layer is composited per viewport:
 *  WebKit's 2D-canvas area cap is about 4096², and a canvas over it goes
 *  blank. */
const VIEWPORT_COMPOSITE_MIN_DIM = 4096;

/** Max side (px) of the stroke buffer. On larger images it is a per-stroke
 *  window into the image. */
const BUFFER_MAX_DIM = 4096;

/**
 * Owns the label masks (`Uint8Array`: 0 = absent, 1 = present, 1..255 =
 * instance id) and composites them into the displayed `combinedCanvas`
 * through per-label colour palettes. Colour lives only in the palette.
 */
@Injectable({
  providedIn: 'root',
})
export class CanvasManagerService implements ProjectScoped {
  private stateService = inject(StateManagerService);
  private labelService = inject(LabelsService);
  private editorService = inject(EditorService);
  private bboxManager = inject(BboxManagerService);
  private webgpuCompositor = inject(WebGPUCanvasCompositorService);
  private zoomPan = inject(ZoomPanService);
  private renderStats = inject(RenderStatsService);

  /** One value mask per segmentation label, row-major, `width*height`. */
  labelMasks: Uint8Array[] = [];
  /** The masks are views borrowed from elsewhere (see `bindMasks`). */
  private masksBorrowed = false;
  /** One 256-entry RGBA lookup table per label (value -> display colour). */
  palettes: Uint8Array[] = [];

  // Full-resolution RGBA composite of the label layers. Not allocated for large
  // images (see `useViewportComposite`).
  combinedCanvas?: OffscreenCanvas;
  combinedCtx?: OffscreenCanvasRenderingContext2D;

  /** The canvas the tools rasterize the stroke in progress onto. On large
   *  images it is a window whose top-left is `bufferOrigin`; its context is
   *  translated by -origin, so tools draw in image coordinates. */
  bufferCanvas: OffscreenCanvas;
  bufferCtx: OffscreenCanvasRenderingContext2D;
  private bufferOrigin = { x: 0, y: 0 };

  requestRedraw: Subject<boolean> = new Subject<boolean>();
  private useWebGPU = false;

  /** Work buffers of the CPU outline paths. */
  private outlineScratch = new OutlineScratch();
  /** One label layer sampled on the device-pixel grid (viewport path). */
  private viewportGrid = new Uint8Array(0);
  /** Contour radius (image px) the combined canvas was last composited with,
   *  0 for none. */
  private compositedRadius = 0;

  /** The image is too large for a native-size composite canvas: the label
   *  layer is composited per viewport (see `compositeToDisplay`). */
  protected useViewportComposite = false;
  get usesViewportComposite(): boolean {
    return this.useViewportComposite;
  }

  constructor() {
    this.initializeWebGPU();
  }

  protected async initializeWebGPU(): Promise<void> {
    this.useWebGPU = await this.webgpuCompositor.initialize();
    console.log(
      `Using ${this.useWebGPU ? 'WebGPU' : 'CPU'} for canvas composition`
    );
  }

  // ── Palettes ─────────────────────────────────────────────────────────────

  rebuildPalettes() {
    this.palettes = this.labelService.listSegmentationLabels.map((label) =>
      buildLabelPalette(label.color, label.shades)
    );
  }

  // ── Composition ──────────────────────────────────────────────────────────

  /** The outline style on a grid where one screen pixel is `gridPxPerScreenPx`
   *  grid pixels; null when labels are drawn plainly. */
  private outlineStyle(gridPxPerScreenPx: number): OutlineStyle | null {
    const alphas = this.editorService.outlineAlphas();
    if (!alphas) return null;
    const radius =
      alphas.contourAlpha > 0
        ? Math.min(
            MAX_OUTLINE_RADIUS,
            Math.max(1, Math.round(this.editorService.outlineContourWidth * gridPxPerScreenPx))
          )
        : 0;
    return { ...alphas, radius };
  }

  /** The outline style at image resolution, for the current zoom. */
  private imageOutlineStyle(): OutlineStyle | null {
    const scale = this.zoomPan.getScale();
    return this.outlineStyle(scale > 0 ? 1 / scale : 1);
  }

  /** The zoom changed the contour radius since the last composite. */
  get outlineStale(): boolean {
    if (this.useViewportComposite) return false; // composited every frame
    return (this.imageOutlineStyle()?.radius ?? 0) !== this.compositedRadius;
  }

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

  /** Recompute the bounding boxes from the masks. `computeCombinedCanvas` does
   *  it for small images; the large-image path calls this. */
  updateBoundingBoxes(): void {
    this.bboxManager.clear();
    if (this.editorService.showBoundingBox) {
      this.computeBoundingBoxes();
    }
  }

  private computeBoundingBoxes() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const labels = this.labelService.listSegmentationLabels;

    // Large images: boxes from a downsampled presence grid (±step px).
    const step = this.useViewportComposite
      ? Math.max(1, Math.ceil(Math.max(w, h) / 2048))
      : 1;

    if (this.editorService.labelledCombinedBoundingBox) {
      if (step > 1) {
        const dw = Math.ceil(w / step);
        const dh = Math.ceil(h / step);
        const grid = new Uint8Array(dw * dh);
        this.labelMasks.forEach((mask, i) => {
          if (labels[i]?.isVisible) downsamplePresence(mask, w, h, step, grid);
        });
        const boxes = connectedComponentBoxes(grid, dw, dh).map((b) => ({
          x: b.x * step,
          y: b.y * step,
          width: b.width * step,
          height: b.height * step,
        }));
        this.bboxManager.addBboxes(boxes, CombinedLabel);
      } else {
        const visible = this.labelMasks.filter((_, i) => labels[i]?.isVisible);
        const union = unionPresence(visible, w, h);
        this.bboxManager.addBboxes(connectedComponentBoxes(union, w, h), CombinedLabel);
      }
    } else {
      this.labelMasks.forEach((mask, index) => {
        if (!labels[index]?.isVisible) return;
        const boxes =
          step > 1
            ? connectedComponentBoxesDownsampled(mask, w, h, step)
            : connectedComponentBoxes(mask, w, h);
        this.bboxManager.addBboxes(boxes, labels[index]);
      });
    }
  }

  private async computeCombinedCanvasGPU() {
    const width = this.stateService.width;
    const height = this.stateService.height;
    try {
      const visibility = this.labelService.listSegmentationLabels.map((l) => l.isVisible);
      const style = this.imageOutlineStyle();
      const imageData = await this.webgpuCompositor.compositeMasks(
        this.labelMasks,
        this.palettes,
        visibility,
        width,
        height,
        style
      );
      this.combinedCtx?.putImageData(imageData, 0, 0);
      this.compositedRadius = style?.radius ?? 0;
    } catch (error) {
      console.error('WebGPU composition failed, falling back to CPU:', error);
      this.computeCombinedCanvasCPU();
    }
  }

  computeCombinedCanvasCPU() {
    if (!this.combinedCtx) return; // viewport-composite mode draws directly
    const w = this.stateService.width;
    const h = this.stateService.height;
    const labels = this.labelService.listSegmentationLabels;

    const img = this.combinedCtx.createImageData(w, h);
    const data = img.data;

    const style = this.imageOutlineStyle();

    // Later labels paint over earlier ones.
    for (let li = 0; li < this.labelMasks.length; li++) {
      if (!labels[li]?.isVisible) continue;
      const mask = this.labelMasks[li];
      const pal = this.palettes[li];
      if (!mask || !pal) continue;

      if (style) {
        paintLayerOutlined(data, mask, pal, w, h, style, this.outlineScratch);
        continue;
      }

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
    this.compositedRadius = style?.radius ?? 0;
  }

  /**
   * Composite the visible label layer straight into a viewport-sized display
   * context (device pixels), sampling each mask through the view transform.
   * For images too large for a native composite canvas.
   */
  compositeToDisplay(ctx: CanvasRenderingContext2D, dpr: number): void {
    const dispW = ctx.canvas.width;   // device px
    const dispH = ctx.canvas.height;
    if (dispW === 0 || dispH === 0) return;

    const w = this.stateService.width;
    const h = this.stateService.height;
    const masks = this.labelMasks;
    const labels = this.labelService.listSegmentationLabels;

    const scale = this.zoomPan.getScale() * dpr;
    if (scale <= 0) return;
    // The integer-snapped offset of `applyViewTransform`, to line up with the
    // image layer.
    const offX = Math.round(this.zoomPan.getOffset().x) * dpr;
    const offY = Math.round(this.zoomPan.getOffset().y) * dpr;
    const invScale = 1 / scale;

    const out = ctx.createImageData(dispW, dispH);
    const data = out.data;
    // Outline radius in device pixels: this grid is the screen.
    const style = this.outlineStyle(dpr);

    // Source column per device column, and source row per device row; -1
    // outside the image.
    const xs = new Int32Array(dispW);
    for (let dx = 0; dx < dispW; dx++) {
      const ix = Math.floor((dx + 0.5 - offX) * invScale);
      xs[dx] = ix >= 0 && ix < w ? ix : -1;
    }
    const ys = new Int32Array(dispH);
    for (let dy = 0; dy < dispH; dy++) {
      const iy = Math.floor((dy + 0.5 - offY) * invScale);
      ys[dy] = iy >= 0 && iy < h ? iy : -1;
    }

    if (style) {
      // Outline mode: each label sampled onto the device grid, then outlined
      // there, so the band is measured in screen pixels. This runs every pan
      // frame and a thick band costs about 2x a 1px one. If it lags: draw 1px
      // while the view moves and the full width once it settles, or move this
      // path to the GPU.
      const n = dispW * dispH;
      if (this.viewportGrid.length < n) this.viewportGrid = new Uint8Array(n);
      const grid = this.viewportGrid.subarray(0, n);
      for (let li = 0; li < masks.length; li++) {
        if (!labels[li]?.isVisible) continue;
        const mask = masks[li];
        const pal = this.palettes[li];
        if (!mask || !pal) continue;
        let any = false;
        for (let dy = 0; dy < dispH; dy++) {
          const outRow = dy * dispW;
          const iy = ys[dy];
          if (iy < 0) {
            grid.fill(0, outRow, outRow + dispW);
            continue;
          }
          const maskRow = iy * w;
          for (let dx = 0; dx < dispW; dx++) {
            const ix = xs[dx];
            const v = ix < 0 ? 0 : mask[maskRow + ix];
            grid[outRow + dx] = v;
            if (v !== 0) any = true;
          }
        }
        if (any) {
          paintLayerOutlined(data, grid, pal, dispW, dispH, style, this.outlineScratch);
        }
      }
      ctx.putImageData(out, 0, 0);
      return;
    }

    for (let dy = 0; dy < dispH; dy++) {
      const iy = ys[dy];
      if (iy < 0) continue;
      const maskRow = iy * w;
      const outRow = dy * dispW;
      for (let dx = 0; dx < dispW; dx++) {
        const ix = xs[dx];
        if (ix < 0) continue;
        const mi = maskRow + ix;

        // Later labels paint over earlier ones.
        for (let li = 0; li < masks.length; li++) {
          if (!labels[li]?.isVisible) continue;
          const v = masks[li][mi];
          if (v === 0) continue;
          const pal = this.palettes[li];
          if (!pal) continue;
          const o = (outRow + dx) * 4;
          const p = v * 4;
          data[o] = pal[p];
          data[o + 1] = pal[p + 1];
          data[o + 2] = pal[p + 2];
          data[o + 3] = pal[p + 3];
        }
      }
    }

    ctx.putImageData(out, 0, 0);
  }

  // ── Allocation / lifecycle ───────────────────────────────────────────────

  protected ensureAuxCanvases(width: number, height: number) {
    if (this.useViewportComposite) {
      this.combinedCanvas = undefined;
      this.combinedCtx = undefined;
    } else {
      if (!this.combinedCanvas) {
        this.combinedCanvas = new OffscreenCanvas(width, height);
        this.combinedCtx = this.combinedCanvas.getContext('2d', {
          alpha: true,
          desynchronized: true,
        })!;
      }
      if (this.combinedCanvas.width !== width || this.combinedCanvas.height !== height) {
        this.combinedCanvas.width = width;
        this.combinedCanvas.height = height;
      }
    }

    // The stroke buffer is capped; on large images it is a window positioned per
    // stroke (see `beginStrokeBuffer`).
    const bw = Math.min(width, BUFFER_MAX_DIM);
    const bh = Math.min(height, BUFFER_MAX_DIM);
    if (!this.bufferCanvas) {
      this.bufferCanvas = new OffscreenCanvas(bw, bh);
      this.bufferCtx = this.bufferCanvas.getContext('2d', { alpha: true })!;
    }
    if (this.bufferCanvas.width !== bw || this.bufferCanvas.height !== bh) {
      this.bufferCanvas.width = bw;
      this.bufferCanvas.height = bh;
    }
    this.bufferOrigin = { x: 0, y: 0 };
    this.bufferCtx.setTransform(1, 0, 0, 1, 0, 0);
  }

  async updateCanvasesDimensions() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const nLabels = this.labelService.listSegmentationLabels.length;

    this.useViewportComposite = Math.max(w, h) > VIEWPORT_COMPOSITE_MIN_DIM;
    this.ensureAuxCanvases(w, h);

    const needsRealloc =
      this.labelMasks.length !== nLabels ||
      (this.labelMasks[0]?.length ?? 0) !== w * h;
    if (needsRealloc) {
      this.labelMasks = Array.from({ length: nLabels }, () => new Uint8Array(w * h));
      this.masksBorrowed = false;
    }
    this.rebuildPalettes();

    await this.webgpuCompositor.prepareResources(w, h, Math.max(1, nLabels));
  }

  // ── Mask access / mutation ───────────────────────────────────────────────

  getActiveIndex() {
    return this.labelService.getActiveIndex();
  }

  getActiveMask(): Uint8Array {
    return this.labelMasks[this.getActiveIndex()];
  }

  getAllMasks(): Uint8Array[] {
    return this.labelMasks;
  }

  /**
   * Use `masks` as the label layers without copying: in 3D mode, views of the
   * current slice of each label volume. They must match the label count and
   * image size.
   */
  bindMasks(masks: Uint8Array[]) {
    this.labelMasks = masks;
    this.masksBorrowed = true;
  }

  /** Replace borrowed layers by owned copies, so later writes cannot reach
   *  the source. */
  detachMasks() {
    if (!this.masksBorrowed) return;
    this.labelMasks = this.labelMasks.map((m) => m.slice());
    this.masksBorrowed = false;
  }

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
    this.combinedCtx?.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  getBufferCanvas() {
    return this.bufferCanvas;
  }
  getBufferCtx() {
    return this.bufferCtx;
  }

  /** Top-left of the stroke buffer window, in image space. */
  getBufferOrigin(): { x: number; y: number } {
    return { x: this.bufferOrigin.x, y: this.bufferOrigin.y };
  }

  /**
   * Clear the stroke buffer and position its window: the whole image when it
   * fits, otherwise `BUFFER_MAX_DIM` pixels centred on `center`. A stroke
   * straying beyond the window is clipped.
   */
  beginStrokeBuffer(center?: { x: number; y: number }): void {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const bw = this.bufferCanvas.width;
    const bh = this.bufferCanvas.height;

    let ox = 0;
    let oy = 0;
    if (center && (bw < w || bh < h)) {
      ox = Math.max(0, Math.min(w - bw, Math.round(center.x - bw / 2)));
      oy = Math.max(0, Math.min(h - bh, Math.round(center.y - bh / 2)));
    }
    this.bufferOrigin = { x: ox, y: oy };

    const ctx = this.bufferCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bw, bh);
    ctx.setTransform(1, 0, 0, 1, -ox, -oy); // tools draw in image space
  }

  /** Read an image-space rectangle of the stroke buffer as RGBA. Pixels
   *  outside the window are transparent. */
  readBufferRegion(rect: { x: number; y: number; width: number; height: number }): Uint8ClampedArray {
    return this.bufferCtx.getImageData(
      rect.x - this.bufferOrigin.x,
      rect.y - this.bufferOrigin.y,
      rect.width,
      rect.height,
    ).data;
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

  /** @see ProjectScoped */
  resetForProject(): void {
    this.detachMasks();
    this.clearAllMasks();
    this.resetCombinedCanvas();
  }
}
