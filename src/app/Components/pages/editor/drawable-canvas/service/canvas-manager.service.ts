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
import {
  connectedComponentBoxes,
  connectedComponentBoxesDownsampled,
  downsamplePresence,
  unionPresence,
} from '../../../../../Core/misc/label-ops';

/** Longest side (px) past which we skip the native-size composite canvas and
 *  composite the label layer per-viewport instead (WebKit's 2D-canvas area cap
 *  is ~4096²; a native composite over it goes blank). */
const VIEWPORT_COMPOSITE_MIN_DIM = 4096;

/** Max side (px) of the stroke scratch buffer — kept within WebKit's cap. On
 *  larger images the buffer becomes a per-stroke window into the image. */
const BUFFER_MAX_DIM = 4096;

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

  // Full-resolution RGBA composite of all label layers. Allocated only for
  // images small enough to be a legal canvas (see `useViewportComposite`);
  // large images composite straight into the viewport-sized display canvas
  // instead, which is cheaper and dodges WebKit's canvas-size cap.
  combinedCanvas?: OffscreenCanvas;
  combinedCtx?: OffscreenCanvasRenderingContext2D;

  /** Scratch canvas the drawing tools rasterize the in-progress stroke onto. On
   *  large images it's a capped window; `bufferOrigin` is its top-left in image
   *  space. The buffer context is translated by -origin so tools keep drawing in
   *  image coordinates. */
  bufferCanvas: OffscreenCanvas;
  bufferCtx: OffscreenCanvasRenderingContext2D;
  private bufferOrigin = { x: 0, y: 0 };

  requestRedraw: Subject<boolean> = new Subject<boolean>();
  private useWebGPU = false;

  /** True for images too large for a native-size composite canvas: the label
   *  layer is then composited per-viewport (see `compositeToDisplay`). */
  private useViewportComposite = false;
  get usesViewportComposite(): boolean {
    return this.useViewportComposite;
  }

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

  /** Recompute the bbox overlay from the current masks (clears first). Public so
   *  the viewport-composite path can drive it — computeCombinedCanvas, which
   *  normally does this, is skipped for large images. */
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

    // On big images (viewport-composite mode) find boxes on a downsampled
    // presence grid (±step px) so we don't flood-fill 100M+ pixels per label on
    // the main thread; smaller images stay exact.
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

  /**
   * Composite the visible label layer directly into a viewport-sized display
   * context (device pixels), sampling each label mask through the view
   * transform. Used for images too large for a native composite canvas: work is
   * bounded by the viewport (not the image), and no over-cap canvas is
   * allocated. `dpr` is the device-pixel ratio the display canvas is scaled by.
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
    // Match applyViewTransform's integer-snapped offset so labels line up with
    // the image layer exactly.
    const offX = Math.round(this.zoomPan.getOffset().x) * dpr;
    const offY = Math.round(this.zoomPan.getOffset().y) * dpr;
    const invScale = 1 / scale;

    const out = ctx.createImageData(dispW, dispH);
    const data = out.data;
    const edges = this.editorService.edgesOnly;
    // Per-device-pixel source id (label*256 + value; 0 = background) — only kept
    // for the edge pass.
    const ids = edges ? new Int32Array(dispW * dispH) : null;

    for (let dy = 0; dy < dispH; dy++) {
      const iy = Math.floor((dy + 0.5 - offY) * invScale);
      if (iy < 0 || iy >= h) continue;
      const maskRow = iy * w;
      const outRow = dy * dispW;
      for (let dx = 0; dx < dispW; dx++) {
        const ix = Math.floor((dx + 0.5 - offX) * invScale);
        if (ix < 0 || ix >= w) continue;
        const mi = maskRow + ix;

        // Later labels paint over earlier ones (masks are disjoint in practice).
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
          if (ids) ids[outRow + dx] = (li + 1) * 256 + v;
        }
      }
    }

    if (ids) this.keepEdgesOnly(data, ids, dispW, dispH);
    ctx.putImageData(out, 0, 0);
  }

  /**
   * Screen-space edge pass for the viewport composite: keep a foreground pixel
   * only when a 4-neighbour has a different source id (label/instance/background
   * boundary). Clears the interior, leaving ~1px outlines at display resolution.
   */
  private keepEdgesOnly(
    data: Uint8ClampedArray,
    ids: Int32Array,
    w: number,
    h: number
  ): void {
    // Snapshot foreground so we can zero interiors without affecting neighbours.
    const keep = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const id = ids[i];
        if (id === 0) continue;
        const edge =
          x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
          ids[i - 1] !== id || ids[i + 1] !== id ||
          ids[i - w] !== id || ids[i + w] !== id;
        if (edge) keep[i] = 1;
      }
    }
    for (let i = 0; i < keep.length; i++) {
      if (!keep[i]) data[i * 4 + 3] = 0; // clear non-edge foreground
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
    if (this.useViewportComposite) {
      // Too large for a native composite canvas — release it (frees a lot of
      // memory) and composite per-viewport instead.
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

    // The stroke scratch buffer holds only the in-progress stroke, so it's
    // capped to a WebKit-legal size; on large images it's a moving window
    // positioned per stroke (see beginStrokeBuffer). Small images get a
    // native-size buffer at origin (0,0) — the pre-existing behaviour, byte for
    // byte.
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
    this.combinedCtx?.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  getBufferCanvas() {
    return this.bufferCanvas;
  }
  getBufferCtx() {
    return this.bufferCtx;
  }

  /** Top-left of the stroke buffer window in image space (0,0 for small images). */
  getBufferOrigin(): { x: number; y: number } {
    return { x: this.bufferOrigin.x, y: this.bufferOrigin.y };
  }

  /**
   * Prepare the scratch buffer for a new stroke: clear it and position its
   * window over the image. Tools then draw in image coordinates (the context is
   * translated by -origin). On small images the window is the whole image at
   * origin (0,0); on large images it's a `BUFFER_MAX_DIM` window centred on
   * `center` (the stroke start), clamped to the image — a stroke straying beyond
   * it is clipped, which is fine for the zoomed-in editing this targets.
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

  /**
   * Read an image-space rectangle back from the stroke buffer as RGBA. Handles
   * the buffer window offset; pixels outside the window come back transparent.
   */
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
}
