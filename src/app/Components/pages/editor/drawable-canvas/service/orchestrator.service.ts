import { Injectable } from '@angular/core';
import { auditTime, BehaviorSubject, merge, Subject } from 'rxjs';

// Services
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageProcessingService } from './image-processing.service';
import { UndoRedoService } from './undo-redo.service';
import { PostProcessService } from './post-process.service';
import { ZoomPanService } from './zoom-pan.service';
import { DrawService } from './draw.service';
import { animationFrameScheduler } from 'rxjs';

export interface ViewTransform {
  scale: number;
  offset: { x: number; y: number };
}

@Injectable({
  providedIn: 'root',
})
export class OrchestratorService {
  // State signals
  private isReadySubject = new BehaviorSubject<boolean>(false);
  public isReady$ = this.isReadySubject.asObservable();

  // Unified redraw request - component subscribes to this single stream
  public redrawRequest = new Subject<void>();

  // Expose the loaded image for the component to draw
  private loadedImage: HTMLImageElement | null = null;

  constructor(
    private state: StateManagerService,
    private imageProc: ImageProcessingService,
    private canvasManager: CanvasManagerService,
    private undoRedo: UndoRedoService,
    private postProcess: PostProcessService,
    private zoomPan: ZoomPanService,
    private drawService: DrawService
  ) {
    this.initializeRedrawAggregation();
  }

  /**
   * Aggregates all redraw requests into a single stream.
   * The component only needs to subscribe to one observable.
   */
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
      this.undoRedo.redrawRequest
    )
      .pipe(auditTime(0, animationFrameScheduler))
      .subscribe((value) => {
        if (value) this.redrawRequest.next();
      });
  }
  public requestRedraw() {
    this.redrawRequest.next();
  }

  /**
   * Single entry point for loading a new image.
   */
  public async loadImage(imgSrc: string): Promise<HTMLImageElement> {
  this.isReadySubject.next(false);
  try {
    const img = await this.preloadImage(imgSrc);
    this.loadedImage = img;

    // 1. Sync dimensions across all services
    this.state.setWidthAndHeight(img.width, img.height);
    await this.canvasManager.updateCanvasesDimensions();

    // 2. Initialize internal states
    this.imageProc.setImage(img);
    this.postProcess.featuresExtracted = false;
    this.state.recomputeCanvasSum = true;

    // 3. Reset view
    const maxDim = Math.max(img.width, img.height);
    this.zoomPan.smooth = maxDim < 2048;
    this.zoomPan.resetZoomAndPan(true, true);

    // 4. Clear history (but don't capture yet - annotations not loaded)
    this.undoRedo.empty();

    this.isReadySubject.next(true);
    this.redrawRequest.next();

    return img;
  } catch (e) {
    console.error('Orchestrator failed to load image:', e);
    throw e;
  }
}

/**
 * Capture initial undo/redo state after annotations are loaded.
 * Must be called after loadImage() and after annotations are loaded into canvases.
 */
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
  // Delegated Getters (Facade Pattern)
  // ==========================================

  public get width(): number {
    return this.state.width;
  }

  public get height(): number {
    return this.state.height;
  }

  public get image(): HTMLImageElement | null {
    return this.loadedImage;
  }

  public getViewTransform(): ViewTransform {
    return {
      scale: this.zoomPan.getScale(),
      offset: this.zoomPan.getOffset(),
    };
  }

  public getViewBox() {
    return this.zoomPan.getViewBox();
  }

  public getSVGViewBox() {
    return this.zoomPan.getSVGViewBox();
  }

  public getProcessedImage(): HTMLCanvasElement | OffscreenCanvas {
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
  // Canvas Operations
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
  // View Controls
  // ==========================================

  public setCanvasContext(canvas: HTMLCanvasElement) {
    this.zoomPan.setContext(canvas);
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
