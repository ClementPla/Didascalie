import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { SequenceService } from '../../../../../Services/sequence.service';
import { UIStateService } from '../../../../../Services/uistate.service';

import { OrchestratorService } from '../service/orchestrator.service';
import { DrawService } from '../service/draw.service';
import { ZoomPanService } from '../service/zoom-pan.service';

import { SVGElementsComponent } from './svgelements/svgelements.component';
import { CanvasInputDirective } from '../directives/canvas-input.directive';
import { Button } from 'primeng/button';

import { Point2D, Viewbox } from '../interface';

@Component({
  selector: 'app-drawable-canvas',
  imports: [CommonModule, FormsModule, Button, SVGElementsComponent, CanvasInputDirective],
  templateUrl: './drawable-canvas.component.html',
  styleUrl: './drawable-canvas.component.scss',
  standalone: true,
})
export class DrawableCanvasComponent implements AfterViewInit, OnDestroy {
  // UI state
  public cursor: Point2D = { x: 0, y: 0 };          // viewport CSS px
  public viewBox: Viewbox = { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
  public isFullscreen = false;
  public rulerSize = 16;
  // True while the pointer is over the actual image (not the surrounding
  // padding). Drives whether the brush cursor / cursor-none applies, so the
  // margin around a zoomed-out image keeps a regular, clickable cursor.
  public isCursorInsideImage = false;

  // Viewport CSS dimensions (drive both canvas style and internal resolution)
  public viewportWidth = 0;
  public viewportHeight = 0;

  // Contexts
  private ctxImage: CanvasRenderingContext2D | null = null;
  private ctxLabel: CanvasRenderingContext2D | null = null;
  private dpr: number = Math.max(1, window.devicePixelRatio || 1);

  // Brush wheel acceleration
  private lastWheelTime = 0;
  private wheelVelocity = 0;
  private wheelDecayTimeout?: number;

  // Cleanup
  private edgeRecomputeTimeout?: number;
  private resizeObserver?: ResizeObserver;
  private destroy$ = new Subject<void>();

  @ViewChild('viewport', { static: true })   public viewportRef: ElementRef<HTMLDivElement>;
  @ViewChild('imageCanvas', { static: true }) public imgCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('labelCanvas', { static: true }) public labelCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('svg')                           public svg: SVGElementsComponent;

  constructor(
    public editorService: EditorService,
    public labelService: LabelsService,
    public sequenceService: SequenceService,
    public orchestrator: OrchestratorService,
    private drawService: DrawService,
    public zoomPanService: ZoomPanService,
    private changeDetectorRef: ChangeDetectorRef,
    private uiStateService: UIStateService,
  ) {
    this.initSubscriptions();

    effect(() => {
      const frame = this.sequenceService.currentFrameImage();
      if (frame && this.ctxImage) this.loadImage(frame.image_base64);
    });
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  ngAfterViewInit() {
    this.ctxImage = this.imgCanvas.nativeElement.getContext('2d', { alpha: true })!;
    this.ctxLabel = this.labelCanvas.nativeElement.getContext('2d', { alpha: true })!;

    this.orchestrator.setViewportRef(this.viewportRef.nativeElement);

    // ResizeObserver drives viewport size. Pushes into ZoomPanService and
    // resizes display canvases to (CSS px × DPR) so the bitmap matches what's
    // on screen. The image and label layers stay at native resolution offscreen.
    this.resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      this.setViewportSize(rect.width, rect.height);
    });
    this.resizeObserver.observe(this.viewportRef.nativeElement);

    // Initial size sync (in case observer hasn't fired yet)
    const r = this.viewportRef.nativeElement.getBoundingClientRect();
    this.setViewportSize(r.width, r.height);

    const frame = this.sequenceService.currentFrameImage();
    if (frame) this.loadImage(frame.image_base64);
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    clearTimeout(this.wheelDecayTimeout);
    clearTimeout(this.edgeRecomputeTimeout);
  }

  private initSubscriptions() {
    this.orchestrator.redrawRequest
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.redrawAllCanvas());

    this.drawService.singleDrawRequest
      .pipe(takeUntil(this.destroy$))
      .subscribe(ctx => {
        if (ctx && this.ctxLabel) {
          // singleDrawRequest is a buffer canvas at image-native resolution.
          // It must go through the same view transform as the main label layer.
          this.applyLabelTransform();
          this.orchestrator.ensurePixelPerfectDrawing(this.ctxLabel);
          this.ctxLabel.drawImage(ctx.canvas, 0, 0);
          this.ctxLabel.resetTransform();
        }
      });
  }

  // ==========================================
  // Viewport sizing
  // ==========================================

  private setViewportSize(width: number, height: number) {
    if (width === 0 || height === 0) return;
    if (width === this.viewportWidth && height === this.viewportHeight) return;

    this.viewportWidth = width;
    this.viewportHeight = height;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    // Display canvases: internal resolution = CSS px × DPR, CSS size = viewport.
    const setCanvas = (c: HTMLCanvasElement) => {
      c.width = Math.round(width * this.dpr);
      c.height = Math.round(height * this.dpr);
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    };
    setCanvas(this.imgCanvas.nativeElement);
    setCanvas(this.labelCanvas.nativeElement);

    this.orchestrator.setViewportSize(width, height);
    this.changeDetectorRef.detectChanges();

    // Trigger a redraw with the new viewport. If no image is loaded yet,
    // redrawAllCanvas no-ops.
    this.orchestrator.requestRedraw();
  }

  @HostListener('window:resize')
  public onWindowResize() {
    // The ResizeObserver handles the viewport div; this catches DPR changes
    // (e.g. user drags window between monitors with different scaling).
    const newDpr = Math.max(1, window.devicePixelRatio || 1);
    if (newDpr !== this.dpr) {
      this.dpr = newDpr;
      const r = this.viewportRef.nativeElement.getBoundingClientRect();
      this.viewportWidth = 0; // force resize
      this.setViewportSize(r.width, r.height);
    }
  }

  // ==========================================
  // Image loading
  // ==========================================

  public async loadImage(imageSrc: string) {
    try {
      await this.orchestrator.loadImage(imageSrc);
      // Offscreen layers were resized inside the orchestrator.
      // The display canvases follow the viewport, not the image, so no
      // further sizing here.
      this.svg.setViewBox(this.orchestrator.getSVGViewBox());
      this.changeDetectorRef.detectChanges();
    } catch (e) {
      console.error('Failed to load image:', e);
    }
  }

  // ==========================================
  // Input
  // ==========================================

  public onMouseMove(data: { event: MouseEvent; coords: Point2D; cursor: Point2D }) {
    if (!this.orchestrator.image) return;

    this.cursor = data.cursor;
    this.zoomPanService.currentPixel = data.coords;

    // Determine if the pointer is over the image itself (raw, unclamped),
    // so the padding around a zoomed-out image keeps a normal cursor.
    const raw = this.zoomPanService.getImageCoordinatesRaw(data.event);
    this.isCursorInsideImage =
      raw.x >= 0 && raw.x < this.orchestrator.width &&
      raw.y >= 0 && raw.y < this.orchestrator.height;

    if (this.editorService.canPan()) {
      this.orchestrator.pan(data.event);
    } else {
      this.drawService.draw(data.event);
    }
  }

  public wheel(event: WheelEvent): void {
    event.preventDefault();

    if (event.ctrlKey) {
      this.handleBrushSizeWheel(event);
      return;
    }

    this.orchestrator.handleWheel(event);
    this.viewBox = this.orchestrator.getViewBox();

    if (this.editorService.edgesOnly) {
      clearTimeout(this.edgeRecomputeTimeout);
      this.edgeRecomputeTimeout = window.setTimeout(() => {
        this.orchestrator.requestRedrawAllCanvas();
      }, 150);
    }
  }

  private handleBrushSizeWheel(event: WheelEvent) {
    const now = performance.now();
    const dt = now - this.lastWheelTime;

    if (dt < 100) this.wheelVelocity = Math.min(this.wheelVelocity + 1, 25);
    else if (dt > 200) this.wheelVelocity = 0;

    this.lastWheelTime = now;

    const exponent = 1 + this.wheelVelocity / 2.0;
    const adjustment = Math.max(1, Math.round(Math.pow(2, exponent)));

    this.editorService.lineWidth += event.deltaY > 0 ? -adjustment : adjustment;
    this.editorService.lineWidth = Math.max(1, this.editorService.lineWidth);

    clearTimeout(this.wheelDecayTimeout);
    this.wheelDecayTimeout = window.setTimeout(() => {
      this.wheelVelocity = 0;
    }, 150);
  }

  // ==========================================
  // Rendering
  // ==========================================

  public async redrawAllCanvas() {
    if (!this.ctxImage || !this.ctxLabel) return;
    if (this.viewportWidth === 0 || this.viewportHeight === 0) return;

    const img = this.orchestrator.image;
    if (!img || !img.complete || img.naturalWidth === 0) return;

    this.viewBox = this.orchestrator.getViewBox();
    this.svg.setViewBox(this.orchestrator.getSVGViewBox());

    // Image layer
    this.clearDisplayCanvas(this.ctxImage);
    this.applyImageTransform();
    this.ctxImage.imageSmoothingEnabled = false;
    const processedImage = this.orchestrator.getProcessedImage();
    if (!processedImage) return;
    this.ctxImage.drawImage(
      processedImage,
      0, 0,
      this.orchestrator.width, this.orchestrator.height
    );
    this.ctxImage.resetTransform();

    // Label layer
    const combined = await this.orchestrator.getCombinedLabelCanvas();
    this.clearDisplayCanvas(this.ctxLabel);
    this.applyLabelTransform();
    this.orchestrator.ensurePixelPerfectDrawing(this.ctxLabel);
    this.ctxLabel.drawImage(combined, 0, 0);
    this.ctxLabel.resetTransform();
  }

  private clearDisplayCanvas(ctx: CanvasRenderingContext2D) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  private applyImageTransform() {
    this.orchestrator.applyViewTransform(this.ctxImage!, this.dpr);
  }

  private applyLabelTransform() {
    this.orchestrator.applyViewTransform(this.ctxLabel!, this.dpr);
  }

  // ==========================================
  // Public API
  // ==========================================

  public loadCanvas(data: string, index: number) {
    this.orchestrator.loadCanvas(data, index);
  }

  public async loadAllCanvas(masks: string[]) {
    await this.orchestrator.loadAllCanvas(masks);
  }

  public switchFullScreen() {
    this.isFullscreen = !this.isFullscreen;
    // Defer to let layout settle, then refit.
    requestAnimationFrame(() => {
      const r = this.viewportRef.nativeElement.getBoundingClientRect();
      this.setViewportSize(r.width, r.height);
      this.orchestrator.resetView(true, true);
    });
  }

  // ==========================================
  // UI helpers
  // ==========================================

  public getCursorSize(): number {
    // Brush is in image px; convert to viewport CSS px.
    return this.editorService.lineWidth * this.zoomPanService.getScale();
  }

  public get isLoading(): boolean {
    return this.uiStateService.isLoading || this.sequenceService.loading();
  }

  public getCursorStyle() {
    const size = this.getCursorSize();
    if (size <= 0) return {};

    // Image-space cursor → viewport CSS px. Single conversion, no DOM scaling.
    const vp = this.zoomPanService.imageToViewport(this.zoomPanService.currentPixel);

    return {
      'left.px': vp.x,
      'top.px': vp.y,
      'width.px': size,
      'height.px': size,
      'margin-left.px': -size / 2,
      'margin-top.px': -size / 2,
      'border-color': this.labelService.activeLabel?.color,
    };
  }

  public getCSSFilterEdge(): string {
    return this.editorService.edgesOnly
      ? 'drop-shadow( 1px  0px 0px black) drop-shadow(-1px  0px 0px black) drop-shadow( 0px  1px 0px black) drop-shadow( 0px -1px 0px black)'
      : '';
  }

  // ==========================================
  // Template getters
  // ==========================================

  get hasImage(): boolean {
    return this.sequenceService.currentFrameImage() !== null;
  }

  get currentFrameName(): string | null {
    return this.sequenceService.currentFrame()?.relative_path ?? null;
  }
}