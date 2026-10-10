import { Injectable, Injector, inject } from '@angular/core';
import { auditTime, BehaviorSubject, merge, Subject, animationFrameScheduler } from 'rxjs';
import { notifyExperimentalImageLoaded } from '../../../../experimental/registry';

import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import { RGBLUT } from './image-adjustment/image-processing.model';
import { UndoRedoService } from './undo-redo.service';
import { ZoomPanService } from './zoom-pan.service';
import { DrawService } from './draw.service';
import { EditorService } from '../../services/editor.service';
import { Point2D } from '../interface';
import { Pyramid, PyramidService } from '../../../../services/pyramid.service';

export interface ViewTransform {
  scale: number;
  offset: Point2D;
}

/** Native longest side (px) past which a display pyramid is built. */
const PYRAMID_MIN_DIM = 4096;
/** Debounce (ms) for rebuilding the pyramid after the processed image changes. */
const PYRAMID_REBUILD_MS = 150;

@Injectable({ providedIn: 'root' })
export class OrchestratorService {
  private state = inject(StateManagerService);
  private imageProc = inject(ImageAdjustmentService);
  private canvasManager = inject(CanvasManagerService);
  private undoRedo = inject(UndoRedoService);
  private zoomPan = inject(ZoomPanService);
  private drawService = inject(DrawService);
  private editorService = inject(EditorService);
  private pyramid = inject(PyramidService);
  private injector = inject(Injector);

  private isReadySubject = new BehaviorSubject<boolean>(false);
  public isReady$ = this.isReadySubject.asObservable();

  public redrawRequest = new Subject<void>();

  private loadedImage: HTMLImageElement | null = null;

  // ── Display pyramid (large images) ─────────────────────────────────────────
  // A multi-resolution copy of the processed image: the display draws the level
  // matched to the zoom. Null for small images, or until the first build.
  private imagePyramid: Pyramid | null = null;
  private pyramidKey: string | null = null;
  private pyramidVersion = 0;
  private pyramidRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.initializeRedrawAggregation();

    // The processed image changed: rebuild the pyramid, debounced.
    this.imageProc.output$.subscribe(() => this.scheduleImagePyramidRebuild());
  }

  public get displayPyramid(): Pyramid | null {
    return this.imagePyramid;
  }

  // ── Redraw aggregation ───────────────────────────────────────────────────

  private initializeRedrawAggregation() {
    this.canvasManager.requestRedraw
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe((value) => {
        if (value) {
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

  // ── Image lifecycle ──────────────────────────────────────────────────────

  public async loadImage(
    imgSrc: string,
    nativeWidth?: number,
    nativeHeight?: number,
  ): Promise<HTMLImageElement> {
    this.isReadySubject.next(false);
    try {
      const img = await this.preloadImage(imgSrc);
      this.loadedImage = img;

      // The previous frame's pyramid has other dimensions.
      this.releaseImagePyramid();

      // Masks and coordinates use the native size; `img` may be a downsampled
      // overview.
      const w = nativeWidth ?? img.width;
      const h = nativeHeight ?? img.height;
      this.state.setWidthAndHeight(w, h);
      await this.canvasManager.updateCanvasesDimensions();

      this.imageProc.setImage(img);
      notifyExperimentalImageLoaded(this.injector);
      this.state.recomputeCanvasSum = true;

      // Smooth pan/zoom only for smaller images: large ones tear.
      const maxDim = Math.max(img.width, img.height);
      this.zoomPan.smooth = maxDim < 2048;

      this.resetHistory();

      this.isReadySubject.next(true);
      this.redrawRequest.next();

      if (this.editorService.resetZoomAfterNavigation) {
        // One frame, for the ResizeObserver to have pushed a viewport size.
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

  // ── Display pyramid (large images) ───────────────────────────────────────

  private scheduleImagePyramidRebuild(): void {
    if (this.pyramidRebuildTimer) clearTimeout(this.pyramidRebuildTimer);
    this.pyramidRebuildTimer = setTimeout(() => {
      this.pyramidRebuildTimer = null;
      void this.rebuildImagePyramid();
    }, PYRAMID_REBUILD_MS);
  }

  private async rebuildImagePyramid(): Promise<void> {
    // Built from the decoded <img>, not from the processed canvas: WebKit cannot
    // allocate a canvas over about 4096², but `drawImage` can downscale a huge
    // image into a legal one. The adjustments are applied to each level below.
    const source = this.loadedImage;
    const w = this.state.width;
    const h = this.state.height;
    if (!source || w === 0 || h === 0) return;

    if (Math.max(w, h) <= PYRAMID_MIN_DIM) {
      this.releaseImagePyramid();
      return;
    }

    const gen = ++this.pyramidVersion;
    const key = `editor-image:${gen}`;
    try {
      // The finest stored level is capped: no native-size copy is kept.
      const pyr = await this.pyramid.getPyramidForSource(source, w, h, key, PYRAMID_MIN_DIM);
      if (gen !== this.pyramidVersion) {
        // A newer rebuild started meanwhile.
        this.pyramid.invalidate(key);
        return;
      }
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
    // Any build in flight discards itself.
    this.pyramidVersion++;
    this.imagePyramid = null;
  }

  // ── Facade getters ───────────────────────────────────────────────────────

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

  /** The image-adjustment LUT and its version, for the native tiles to match
   *  the backdrop pyramid; null when nothing is to be applied. */
  public tileAdjustment(): { lut: RGBLUT; version: number } | null {
    const lut = this.imageProc.activeLUT();
    return lut ? { lut, version: this.imageProc.version } : null;
  }

  public async getCombinedLabelCanvas(): Promise<OffscreenCanvas | undefined> {
    if (this.state.recomputeCanvasSum) {
      await this.canvasManager.computeCombinedCanvas();
      this.state.recomputeCanvasSum = false;
    }
    return this.canvasManager.getCombinedCanvas();
  }

  public get usesViewportComposite(): boolean {
    return this.canvasManager.usesViewportComposite;
  }

  public compositeLabelLayer(ctx: CanvasRenderingContext2D, dpr: number): void {
    this.canvasManager.compositeToDisplay(ctx, dpr);
  }

  public updateBoundingBoxes(): void {
    this.canvasManager.updateBoundingBoxes();
  }

  public getBufferOrigin(): Point2D {
    return this.canvasManager.getBufferOrigin();
  }

  // ── Canvas operations ────────────────────────────────────────────────────

  public ensurePixelPerfectDrawing(ctx: CanvasRenderingContext2D) {
    this.canvasManager.ensurePixelPerfectDrawing(ctx);
  }

  // ── View controls ────────────────────────────────────────────────────────

  public setViewportRef(el: HTMLElement) {
    this.zoomPan.setViewportRef(el);
  }

  public setViewportSize(width: number, height: number) {
    this.zoomPan.setViewportSize(width, height);
  }

  public applyViewTransform(ctx: CanvasRenderingContext2D, dpr: number) {
    this.zoomPan.applyViewTransform(ctx, dpr);
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