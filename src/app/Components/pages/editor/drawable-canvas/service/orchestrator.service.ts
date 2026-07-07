import { Injectable, Injector } from '@angular/core';
import { auditTime, BehaviorSubject, merge, Subject, animationFrameScheduler } from 'rxjs';
import { notifyExperimentalImageLoaded } from '../../../../../experimental/registry';

import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import { UndoRedoService } from './undo-redo.service';
import { PostProcessService } from './post-process.service';
import { ZoomPanService } from './zoom-pan.service';
import { DrawService } from './draw.service';
import { EditorService } from '../../services/editor.service';
import { Point2D } from '../interface';
import { Pyramid, PyramidService } from '../../../../../Services/pyramid.service';

export interface ViewTransform {
  scale: number;
  offset: Point2D;
}

/** Only build a display pyramid past this native longest-side (px). Below it,
 *  drawing the full image each frame is cheap, so we keep the simple path. */
const PYRAMID_MIN_DIM = 4096;
/** Debounce (ms) for rebuilding the pyramid after the processed image changes. */
const PYRAMID_REBUILD_MS = 150;

@Injectable({ providedIn: 'root' })
export class OrchestratorService {
  private isReadySubject = new BehaviorSubject<boolean>(false);
  public isReady$ = this.isReadySubject.asObservable();

  /** Single redraw stream the component subscribes to. */
  public redrawRequest = new Subject<void>();

  private loadedImage: HTMLImageElement | null = null;

  // ── Display pyramid (large images) ─────────────────────────────────────────
  // A multi-resolution copy of the *processed* image. When present, the display
  // draws the level matched to the current zoom instead of scaling the full
  // native image, which is much cheaper (especially on software-rendered
  // webviews). Null for small images or until the first build completes — the
  // component falls back to drawing the full processed image, so behaviour is
  // never worse than before.
  private imagePyramid: Pyramid | null = null;
  private pyramidKey: string | null = null;
  private pyramidVersion = 0;
  private pyramidRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private state: StateManagerService,
    private imageProc: ImageAdjustmentService,
    private canvasManager: CanvasManagerService,
    private undoRedo: UndoRedoService,
    private postProcess: PostProcessService,
    private zoomPan: ZoomPanService,
    private drawService: DrawService,
    private editorService: EditorService,
    private pyramid: PyramidService,
    private injector: Injector,
  ) {
    this.initializeRedrawAggregation();

    // The processed image changed (frame load, brightness/gamma, …) — rebuild
    // the display pyramid. Debounced so a slider drag doesn't thrash it; the
    // full-image fallback covers the brief window until the rebuild lands.
    this.imageProc.output$.subscribe(() => this.scheduleImagePyramidRebuild());
  }

  /** The current display pyramid of the processed image, or null (use the full
   *  image). Read by the drawable-canvas when drawing the image layer. */
  public get displayPyramid(): Pyramid | null {
    return this.imagePyramid;
  }

  // ==========================================
  // Redraw aggregation
  // ==========================================

  private initializeRedrawAggregation() {
    this.canvasManager.requestRedraw
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe((value) => {
        if (value) {
          // Colour lives in the palettes now; rebuild them and recomposite.
          this.canvasManager.rebuildPalettes();
          this.state.recomputeCanvasSum = true;
          this.redrawRequest.next();
        }
      });

    merge(
      this.zoomPan.redrawRequest,
      this.drawService.redrawRequest,
      this.undoRedo.redrawRequest,
    )
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe((value) => {
        if (value) this.redrawRequest.next();
      });
  }

  public requestRedraw() {
    this.redrawRequest.next();
  }

  public requestRedrawAllCanvas() {
    this.state.recomputeCanvasSum = true;
    this.requestRedraw();
  }

  // ==========================================
  // Image lifecycle
  // ==========================================

  public async loadImage(
    imgSrc: string,
    nativeWidth?: number,
    nativeHeight?: number,
  ): Promise<HTMLImageElement> {
    this.isReadySubject.next(false);
    try {
      const img = await this.preloadImage(imgSrc);
      this.loadedImage = img;

      // Drop the previous frame's pyramid immediately — its dimensions differ,
      // so drawing it onto the new frame would stretch the old image. A rebuild
      // is triggered by the imageProc.output$ emission from setImage() below.
      this.releaseImagePyramid();

      // Masks/coordinates use the NATIVE size; `img` may be a downsampled
      // overview (large images), drawn scaled to the native display space.
      const w = nativeWidth ?? img.width;
      const h = nativeHeight ?? img.height;
      this.state.setWidthAndHeight(w, h);
      await this.canvasManager.updateCanvasesDimensions();

      this.imageProc.setImage(img);
      this.postProcess.featuresExtracted = false;
      // Let experimental features (superpixel map, …) invalidate their
      // per-image caches.
      notifyExperimentalImageLoaded(this.injector);
      this.state.recomputeCanvasSum = true;

      // Smooth pan/zoom only for smaller images; large ones tear.
      const maxDim = Math.max(img.width, img.height);
      this.zoomPan.smooth = maxDim < 2048;

      this.resetHistory();

      this.isReadySubject.next(true);
      this.redrawRequest.next();

      if (this.editorService.resetZoomAfterNavigation) {
        // Wait for the component's ResizeObserver to have pushed a viewport
        // size at least once before fitting. One rAF is enough.
        requestAnimationFrame(() => this.zoomPan.resetZoomAndPan(true, true));
      }

      return img;
    } catch (e) {
      console.error('Orchestrator failed to load image:', e);
      throw e;
    }
  }

  public resetHistory(): void {
    this.undoRedo.empty();
  }

  public async captureInitialHistory(): Promise<void> {
    await this.undoRedo.captureInitialStates();
  }

  private preloadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  // ==========================================
  // Display pyramid (large images)
  // ==========================================

  private scheduleImagePyramidRebuild(): void {
    if (this.pyramidRebuildTimer) clearTimeout(this.pyramidRebuildTimer);
    this.pyramidRebuildTimer = setTimeout(() => {
      this.pyramidRebuildTimer = null;
      void this.rebuildImagePyramid();
    }, PYRAMID_REBUILD_MS);
  }

  private async rebuildImagePyramid(): Promise<void> {
    // Build from the decoded <img>, NOT the processed source canvas: on WebKit a
    // native-resolution canvas over ~4096² can't be allocated (it goes blank),
    // whereas `drawImage(hugeImg, 0,0, ≤cap, ≤cap)` downscales into a legal-size
    // level. This is what lets large images display at all on WebKit. We bake
    // the current adjustments into each (small) level below, so brightness/gamma
    // still show without ever touching a native-size canvas.
    const source = this.loadedImage;
    const w = this.state.width;
    const h = this.state.height;
    if (!source || w === 0 || h === 0) return;

    // Small images don't need a pyramid — draw the full image directly.
    if (Math.max(w, h) <= PYRAMID_MIN_DIM) {
      this.releaseImagePyramid();
      return;
    }

    const gen = ++this.pyramidVersion;
    const key = `editor-image:${gen}`;
    try {
      // Cap the finest stored level so we never keep a native-size copy of a
      // large image in memory; the component draws the source when it needs
      // finer than this.
      const pyr = await this.pyramid.getPyramidForSource(source, w, h, key, PYRAMID_MIN_DIM);
      if (gen !== this.pyramidVersion) {
        // A newer rebuild started while we were building — discard this one.
        this.pyramid.invalidate(key);
        return;
      }
      // Bake current adjustments into each level (no-op at identity). Each level
      // is ≤ the cap, so this stays within WebKit's canvas-size limit.
      for (const level of pyr.levels) {
        this.imageProc.applyCurrentAdjustmentsInPlace(level.canvas);
      }
      if (this.pyramidKey && this.pyramidKey !== key) {
        this.pyramid.invalidate(this.pyramidKey); // bound cache memory
      }
      this.pyramidKey = key;
      this.imagePyramid = pyr;
      this.redrawRequest.next();
    } catch (e) {
      console.error('[Orchestrator] display pyramid build failed:', e);
    }
  }

  private releaseImagePyramid(): void {
    if (this.pyramidRebuildTimer) {
      clearTimeout(this.pyramidRebuildTimer);
      this.pyramidRebuildTimer = null;
    }
    if (this.pyramidKey) {
      this.pyramid.invalidate(this.pyramidKey);
      this.pyramidKey = null;
    }
    // Bump the version so any in-flight build discards itself.
    this.pyramidVersion++;
    this.imagePyramid = null;
  }

  // ==========================================
  // Facade getters
  // ==========================================

  public get width(): number { return this.state.width; }
  public get height(): number { return this.state.height; }
  public get image(): HTMLImageElement | null { return this.loadedImage; }

  public getViewTransform(): ViewTransform {
    return { scale: this.zoomPan.getScale(), offset: this.zoomPan.getOffset() };
  }

  public getViewBox()    { return this.zoomPan.getViewBox(); }
  public getSVGViewBox() { return this.zoomPan.getSVGViewBox(); }

  public getProcessedImage(): HTMLCanvasElement | OffscreenCanvas | null {
    return this.imageProc.getCurrentCanvas();
  }

  public async getCombinedLabelCanvas(): Promise<OffscreenCanvas | undefined> {
    if (this.state.recomputeCanvasSum) {
      await this.canvasManager.computeCombinedCanvas();
      this.state.recomputeCanvasSum = false;
    }
    return this.canvasManager.getCombinedCanvas();
  }

  /** True when the label layer is composited per-viewport (large images). */
  public get usesViewportComposite(): boolean {
    return this.canvasManager.usesViewportComposite;
  }

  /** Composite the visible label layer straight into a display context. Used
   *  in viewport-composite mode instead of drawing a native combined canvas. */
  public compositeLabelLayer(ctx: CanvasRenderingContext2D, dpr: number): void {
    this.canvasManager.compositeToDisplay(ctx, dpr);
  }

  /** Recompute the bbox overlay from the masks (viewport-composite path only —
   *  the combined-canvas path already does this inside computeCombinedCanvas). */
  public updateBoundingBoxes(): void {
    this.canvasManager.updateBoundingBoxes();
  }

  /** Top-left (image space) of the stroke buffer window; (0,0) for small
   *  images. The live-stroke preview draws the buffer at this offset. */
  public getBufferOrigin(): Point2D {
    return this.canvasManager.getBufferOrigin();
  }

  // ==========================================
  // Canvas operations
  // ==========================================

  public ensurePixelPerfectDrawing(ctx: CanvasRenderingContext2D) {
    this.canvasManager.ensurePixelPerfectDrawing(ctx);
  }

  // ==========================================
  // View controls
  // ==========================================

  /** Element used for client→viewport coordinate conversion. */
  public setViewportRef(el: HTMLElement) {
    this.zoomPan.setViewportRef(el);
  }

  /** Pushed from the component's ResizeObserver. */
  public setViewportSize(width: number, height: number) {
    this.zoomPan.setViewportSize(width, height);
  }

  /** Apply the view transform to a display canvas context (DPR-aware). */
  public applyViewTransform(ctx: CanvasRenderingContext2D, dpr: number) {
    this.zoomPan.applyViewTransform(ctx, dpr);
  }

  /** @deprecated Use setViewportRef. */
  public setCanvasContext(canvas: HTMLCanvasElement) {
    this.zoomPan.setViewportRef(canvas);
  }

  public resetView(resetZoom: boolean, resetPan: boolean) {
    this.zoomPan.resetZoomAndPan(resetZoom, resetPan);
  }

  public handleWheel(event: WheelEvent) {
    this.state.recomputeCanvasSum = false;
    this.zoomPan.wheel(event);
  }

  public startPan(event: MouseEvent) {
    this.state.recomputeCanvasSum = false;
    this.zoomPan.startDrag(event);
  }

  public pan(event: MouseEvent) {
    this.zoomPan.drag(event);
  }

  public endPan() {
    this.zoomPan.endDrag();
  }
}