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
      const imageData = await this.webgpuCompositor.compositeMasks(
        this.labelMasks,
        this.palettes,
        visibility,
        width,
        height,
        this.editorService.edgesOnly
      );
      this.combinedCtx?.putImageData(imageData, 0, 0);
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

    const edges = this.editorService.edgesOnly;
    // Target ~2px on screen -> need ceil(2/scale) px in image space.
    const radius = edges
      ? Math.min(Math.max(1, Math.ceil(2 / this.zoomPan.getScale())), 10)
      : 0;

    // Later labels paint over earlier ones.
    for (let li = 0; li < this.labelMasks.length; li++) {
      if (!labels[li]?.isVisible) continue;
      const mask = this.labelMasks[li];
      const pal = this.palettes[li];
      if (!mask || !pal) continue;

      if (edges) {
        this.paintLayerEdges(data, mask, pal, w, h, radius);
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
  }

  /**
   * Paint only the edges of one label mask into `data`. Edges are found per
   * mask, before flattening, so a label under another keeps its outline. A
   * pixel is an edge when a tap holds a different value or falls outside the
   * image. Taps are the 4 direct neighbours plus 8 at distance `radius`:
   * constant cost whatever the thickness, but a hole smaller than `radius` only
   * gets a 1px outline.
   */
  private paintLayerEdges(
    data: Uint8ClampedArray,
    mask: Uint8Array,
    pal: Uint8Array,
    w: number,
    h: number,
    radius: number
  ): void {
    const r = radius;
    const rw = r * w;

    for (let y = 0; y < h; y++) {
      const row = y * w;
      const yNear = y >= 1 && y < h - 1;
      const yFar = y >= r && y < h - r;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const v = mask[i];
        if (v === 0) continue;

        let edge =
          !yNear || x < 1 || x >= w - 1 ||
          mask[i - 1] !== v || mask[i + 1] !== v ||
          mask[i - w] !== v || mask[i + w] !== v;

        if (!edge && r > 1) {
          edge =
            !yFar || x < r || x >= w - r ||
            mask[i - r] !== v || mask[i + r] !== v ||
            mask[i - rw] !== v || mask[i + rw] !== v ||
            mask[i - rw - r] !== v || mask[i - rw + r] !== v ||
            mask[i + rw - r] !== v || mask[i + rw + r] !== v;
        }
        if (!edge) continue;

        const o = i * 4;
        const p = v * 4;
        data[o] = pal[p];
        data[o + 1] = pal[p + 1];
        data[o + 2] = pal[p + 2];
        data[o + 3] = 255;
      }
    }
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
    const edges = this.editorService.edgesOnly;

    // Source column per device column, padded by one on each side for the edge
    // test.
    const xs = new Int32Array(dispW + 2);
    for (let dx = -1; dx <= dispW; dx++) {
      xs[dx + 1] = Math.floor((dx + 0.5 - offX) * invScale);
    }

    for (let dy = 0; dy < dispH; dy++) {
      const iy = Math.floor((dy + 0.5 - offY) * invScale);
      if (iy < 0 || iy >= h) continue;
      const iyU = Math.floor((dy - 0.5 - offY) * invScale);
      const iyD = Math.floor((dy + 1.5 - offY) * invScale);
      const yInside = iyU >= 0 && iyD < h;
      const maskRow = iy * w;
      const rowU = iyU * w;
      const rowD = iyD * w;
      const outRow = dy * dispW;
      for (let dx = 0; dx < dispW; dx++) {
        const ix = xs[dx + 1];
        if (ix < 0 || ix >= w) continue;
        const ixL = xs[dx];
        const ixR = xs[dx + 2];
        const mi = maskRow + ix;

        for (let li = 0; li < masks.length; li++) {
          if (!labels[li]?.isVisible) continue;
          const mask = masks[li];
          const v = mask[mi];
          if (v === 0) continue;
          const pal = this.palettes[li];
          if (!pal) continue;
          // Edge mode, per label in screen space: interior pixels (the 4 neighbouring
          // device pixels sample the same value) are skipped.
          if (
            edges &&
            yInside && ixL >= 0 && ixR < w &&
            mask[maskRow + ixL] === v && mask[maskRow + ixR] === v &&
            mask[rowU + ix] === v && mask[rowD + ix] === v
          ) {
            continue;
          }
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

  /** @see ProjectScoped */
  resetForProject(): void {
    this.detachMasks();
    this.clearAllMasks();
    this.resetCombinedCanvas();
  }
}
