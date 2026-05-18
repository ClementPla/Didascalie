import { Injectable } from '@angular/core';
import { auditTime, BehaviorSubject, merge, Subject, animationFrameScheduler } from 'rxjs';

import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import { UndoRedoService } from './undo-redo.service';
import { PostProcessService } from './post-process.service';
import { ZoomPanService } from './zoom-pan.service';
import { DrawService } from './draw.service';
import { EditorService } from '../../services/editor.service';
import { Point2D } from '../interface';

export interface ViewTransform {
  scale: number;
  offset: Point2D;
}

@Injectable({ providedIn: 'root' })
export class OrchestratorService {
  private isReadySubject = new BehaviorSubject<boolean>(false);
  public isReady$ = this.isReadySubject.asObservable();

  /** Single redraw stream the component subscribes to. */
  public redrawRequest = new Subject<void>();

  private loadedImage: HTMLImageElement | null = null;

  constructor(
    private state: StateManagerService,
    private imageProc: ImageAdjustmentService,
    private canvasManager: CanvasManagerService,
    private undoRedo: UndoRedoService,
    private postProcess: PostProcessService,
    private zoomPan: ZoomPanService,
    private drawService: DrawService,
    private editorService: EditorService,
  ) {
    this.initializeRedrawAggregation();
  }

  // ==========================================
  // Redraw aggregation
  // ==========================================

  private initializeRedrawAggregation() {
    this.canvasManager.requestRedraw
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe((value) => {
        if (value) {
          this.drawService.refreshAllColors();
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

  public async loadImage(imgSrc: string): Promise<HTMLImageElement> {
    this.isReadySubject.next(false);
    try {
      const img = await this.preloadImage(imgSrc);
      this.loadedImage = img;

      this.state.setWidthAndHeight(img.width, img.height);
      await this.canvasManager.updateCanvasesDimensions();

      this.imageProc.setImage(img);
      this.postProcess.featuresExtracted = false;
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

  public async getCombinedLabelCanvas(): Promise<OffscreenCanvas> {
    if (this.state.recomputeCanvasSum) {
      await this.canvasManager.computeCombinedCanvas();
      this.state.recomputeCanvasSum = false;
    }
    return this.canvasManager.getCombinedCanvas();
  }

  // ==========================================
  // Canvas operations
  // ==========================================

  public loadCanvas(data: string, index: number) {
    this.canvasManager.loadCanvas(data, index);
    this.undoRedo.captureInitialState(index);
  }

  public async loadAllCanvas(masks: string[]) {
    this.canvasManager.loadAllCanvas(masks);
    this.undoRedo.empty();
    await this.undoRedo.captureInitialStates();
    this.redrawRequest.next();
  }

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