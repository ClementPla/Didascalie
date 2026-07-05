import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  HostListener,
  Injector,
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
import { StateManagerService } from '../service/state-manager.service';
import { ZoomPanService } from '../service/zoom-pan.service';

import { SVGElementsComponent } from './svgelements/svgelements.component';
import { VectorLayerComponent } from './vector-layer/vector-layer.component';
import { VectorEditorService } from '../service/vector-editor.service';
import { CanvasInputDirective } from '../directives/canvas-input.directive';
import { Button } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { SelectModule } from 'primeng/select';

import { Point2D, Viewbox } from '../interface';
import { FeatureFlagsService } from '../../../../../experimental/feature-flags.service';
import { collectExperimentalOverlays } from '../../../../../experimental/registry';
import { RenderStatsService } from '../../../../Utils/fps-display/render-stats.service';

@Component({
  selector: 'app-drawable-canvas',
  imports: [CommonModule, FormsModule, Button, TooltipModule, SelectModule, SVGElementsComponent, VectorLayerComponent, CanvasInputDirective],
  templateUrl: './drawable-canvas.component.html',
  styleUrl: './drawable-canvas.component.scss',
  standalone: true,
})
export class DrawableCanvasComponent implements AfterViewInit, OnDestroy {
  // UI state
  public cursor: Point2D = { x: 0, y: 0 };          // viewport CSS px
  public viewBox: Viewbox = { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
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
  private ctxOverlay: CanvasRenderingContext2D | null = null;
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
  @ViewChild('overlayCanvas', { static: true }) public overlayCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('labelCanvas', { static: true }) public labelCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('svg')                           public svg: SVGElementsComponent;
  @ViewChild('vectorLayer')                   public vectorLayer: VectorLayerComponent;

  constructor(
    public editorService: EditorService,
    public labelService: LabelsService,
    public sequenceService: SequenceService,
    public orchestrator: OrchestratorService,
    private drawService: DrawService,
    private stateService: StateManagerService,
    public zoomPanService: ZoomPanService,
    private changeDetectorRef: ChangeDetectorRef,
    private uiStateService: UIStateService,
    public vectorEditor: VectorEditorService,
    private featureFlags: FeatureFlagsService,
    private injector: Injector,
    private renderStats: RenderStatsService,
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
    this.ctxOverlay = this.overlayCanvas.nativeElement.getContext('2d', { alpha: true })!;

    this.orchestrator.setViewportRef(this.viewportRef.nativeElement);

    // ResizeObserver drives viewport size. Pushes into ZoomPanService and
    // resizes display canvases to (CSS px × DPR) so the bitmap matches what's
    // on screen. The image and label layers stay at native resolution offscreen.
    this.resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      this.setViewportSize(rect.width, rect.height);
    });
    this.resizeObserver.observe(this.viewportRef.nativeElement);

    // Initial size sync + first draw. Deferred out of the AfterViewInit check:
    // setViewportSize triggers a redraw that updates view-bound state (viewBox,
    // image dimensions), which would otherwise mutate values already rendered
    // this pass and raise NG0100 (ExpressionChangedAfterItHasBeenChecked).
    setTimeout(() => {
      const r = this.viewportRef.nativeElement.getBoundingClientRect();
      this.setViewportSize(r.width, r.height);

      const frame = this.sequenceService.currentFrameImage();
      if (frame) this.loadImage(frame.image_base64);
    });
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
    setCanvas(this.overlayCanvas.nativeElement);
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
      this.vectorLayer?.setViewBox(this.orchestrator.getSVGViewBox());
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
    } else if (this.editorService.isVectorTool()) {
      this.vectorEditor.onPointerMove(raw);
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

    const t0 = performance.now();
    try {
      await this.redrawAllCanvasInner();
    } finally {
      this.renderStats.recordRedraw(performance.now() - t0);
    }
  }

  private async redrawAllCanvasInner() {
    // Re-narrow: the null guard lives in the public wrapper, and that
    // narrowing doesn't carry across the method boundary.
    if (!this.ctxImage || !this.ctxLabel) return;

    this.viewBox = this.orchestrator.getViewBox();
    this.svg.setViewBox(this.orchestrator.getSVGViewBox());
    this.vectorLayer?.setViewBox(this.orchestrator.getSVGViewBox());

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

    // Experimental overlay layer (image-native resolution, same view
    // transform as the label layer). Features expose overlays through the
    // registry (e.g. superpixel boundaries); nothing is drawn while the
    // experimental switch is off.
    if (this.ctxOverlay) {
      this.clearDisplayCanvas(this.ctxOverlay);
      const overlays = this.featureFlags.experimentalEnabled()
        ? collectExperimentalOverlays(this.injector)
        : [];
      if (overlays.length > 0) {
        this.orchestrator.applyViewTransform(this.ctxOverlay, this.dpr);
        this.orchestrator.ensurePixelPerfectDrawing(this.ctxOverlay);
        for (const overlay of overlays) {
          this.ctxOverlay.drawImage(overlay, 0, 0);
        }
        this.ctxOverlay.resetTransform();
      }
    }

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
  // UI helpers
  // ==========================================

  public getCursorSize(): number {
    // Brush is in image px; convert to viewport CSS px. While drawing, reflect
    // the live pressure scaling so the cursor matches the actual stroke width.
    const pressureScale = this.stateService.isDrawing
      ? this.editorService.brushPressureScale()
      : 1;
    return this.editorService.lineWidth * pressureScale * this.zoomPanService.getScale();
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

  // ==========================================
  // Ruler ticks
  // ==========================================

  /**
   * Pick a "nice" tick interval (in image px) so that major ticks land
   * roughly `targetPx` apart on screen at the current zoom.
   */
  private niceStepImg(targetPx: number): number {
    const scale = Math.max(this.zoomPanService.getScale(), 1e-6);
    const raw = targetPx / scale;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return nice * pow;
  }

  /**
   * Build the tick-mark background for a ruler. Minor ticks every 1/5 of a
   * major step; both anchored to the inner edge and offset by the image
   * origin so they pan/zoom in lock-step with the image.
   */
  public getRulerTicks(axis: 'x' | 'y'): Record<string, string> {
    const scale = this.zoomPanService.getScale();
    const major = this.niceStepImg(80) * scale;
    if (!isFinite(major) || major <= 0) return {};
    const minor = major / 5;
    const origin = axis === 'x' ? this.viewBox.xmin : this.viewBox.ymin;
    const dir = axis === 'x' ? 'to right' : 'to bottom';

    const line = `linear-gradient(${dir}, var(--ruler-tick) 0 1px, transparent 1px)`;
    const minorLen = 6;
    const majorLen = 11;

    if (axis === 'x') {
      return {
        'background-image': `${line}, ${line}`,
        'background-size': `${minor}px ${minorLen}px, ${major}px ${majorLen}px`,
        'background-position': `${origin}px 100%, ${origin}px 100%`,
        'background-repeat': 'repeat-x',
      };
    }
    return {
      'background-image': `${line}, ${line}`,
      'background-size': `${minorLen}px ${minor}px, ${majorLen}px ${major}px`,
      'background-position': `100% ${origin}px, 100% ${origin}px`,
      'background-repeat': 'repeat-y',
    };
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