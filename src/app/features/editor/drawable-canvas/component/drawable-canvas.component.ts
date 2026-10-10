import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, HostListener, Injector, OnDestroy, effect, inject, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { animationFrameScheduler, Subject } from 'rxjs';
import { auditTime, takeUntil } from 'rxjs/operators';

import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../services/labels/labels.service';
import { SequenceService } from '../../../../services/sequence.service';
import { UIStateService } from '../../../../services/uistate.service';

import { OrchestratorService } from '../service/orchestrator.service';
import { DrawService } from '../service/draw.service';
import { StateManagerService } from '../service/state-manager.service';
import { ZoomPanService } from '../service/zoom-pan.service';

import { SVGElementsComponent } from './svgelements/svgelements.component';
import { VectorLayerComponent } from './vector-layer/vector-layer.component';
import { VectorEditorService } from '../service/vector-editor.service';
import { CanvasInputDirective } from '../directives/canvas-input.directive';
import { labelPickerItems } from '../label-picker';
import { Button } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { SelectModule } from 'primeng/select';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import { MenuItem } from 'primeng/api';

import { Point2D, Viewbox } from '../interface';
import { FeatureFlagsService } from '../../../../experimental/feature-flags.service';
import {
  collectExperimentalOverlays,
  experimentalCanvasOverlays,
} from '../../../../experimental/registry';
import { RenderStatsService } from '../../../../shared/fps-display/render-stats.service';
import { PyramidService } from '../../../../services/pyramid.service';
import { MaskVolumeService } from '../../../../services/mask-volume.service';
import { TiledImageService } from '../service/tiled-image.service';

@Component({
  selector: 'app-drawable-canvas',
  imports: [CommonModule, FormsModule, Button, TooltipModule, SelectModule, ContextMenuModule, SVGElementsComponent, VectorLayerComponent, CanvasInputDirective],
  templateUrl: './drawable-canvas.component.html',
  styleUrl: './drawable-canvas.component.scss',
  standalone: true,
})
export class DrawableCanvasComponent implements AfterViewInit, OnDestroy {
  editorService = inject(EditorService);
  labelService = inject(LabelsService);
  sequenceService = inject(SequenceService);
  orchestrator = inject(OrchestratorService);
  private drawService = inject(DrawService);
  private stateService = inject(StateManagerService);
  zoomPanService = inject(ZoomPanService);
  private changeDetectorRef = inject(ChangeDetectorRef);
  private uiStateService = inject(UIStateService);
  vectorEditor = inject(VectorEditorService);
  private featureFlags = inject(FeatureFlagsService);
  private injector = inject(Injector);
  private renderStats = inject(RenderStatsService);
  private pyramidService = inject(PyramidService);
  private tiledImage = inject(TiledImageService);
  private volume = inject(MaskVolumeService);

  readonly experimentalOverlays = experimentalCanvasOverlays();

  public cursor: Point2D = { x: 0, y: 0 };          // viewport CSS px
  public viewBox: Viewbox = { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
  public rulerSize = 16;
  // The pointer is over the image, not the padding around it.
  public isCursorInsideImage = false;

  readonly labelMenu = viewChild<ContextMenu>('labelMenu');
  /** Labels offered by the right-click picker (see `labelPickerItems`). */
  public labelMenuItems: MenuItem[] = [];

  public openLabelPicker(event: MouseEvent): void {
    this.labelMenuItems = labelPickerItems(this.labelService);
    this.labelMenu()?.show(event);
  }

  public viewportWidth = 0;
  public viewportHeight = 0;

  private ctxImage: CanvasRenderingContext2D | null = null;
  private ctxLabel: CanvasRenderingContext2D | null = null;
  private ctxOverlay: CanvasRenderingContext2D | null = null;
  private dpr: number = Math.max(1, window.devicePixelRatio || 1);

  private lastWheelTime = 0;
  private wheelVelocity = 0;
  private wheelDecayTimeout?: number;

  private edgeRecomputeTimeout?: number;
  private resizeObserver?: ResizeObserver;
  private destroy$ = new Subject<void>();

  public readonly viewportRef = viewChild.required<ElementRef<HTMLDivElement>>('viewport');
  public readonly imgCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('imageCanvas');
  public readonly overlayCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('overlayCanvas');
  public readonly labelCanvas = viewChild.required<ElementRef<HTMLCanvasElement>>('labelCanvas');
  public readonly svg = viewChild.required<SVGElementsComponent>('svg');
  public readonly vectorLayer = viewChild<VectorLayerComponent>('vectorLayer');

  constructor() {
    this.initSubscriptions();

    effect(() => {
      const frame = this.sequenceService.currentFrameImage();
      if (frame && this.ctxImage) {
        this.loadImage(frame.imageBase64, frame.frame.width, frame.frame.height);
      }
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngAfterViewInit() {
    this.ctxImage = this.imgCanvas().nativeElement.getContext('2d', { alpha: true })!;
    this.ctxLabel = this.labelCanvas().nativeElement.getContext('2d', { alpha: true })!;
    this.ctxOverlay = this.overlayCanvas().nativeElement.getContext('2d', { alpha: true })!;

    const viewportRef = this.viewportRef();
    this.orchestrator.setViewportRef(viewportRef.nativeElement);

    // Display canvases are resized to CSS px × DPR; the image and label layers
    // stay at native resolution off-screen.
    this.resizeObserver = new ResizeObserver(entries => {
      const rect = entries[0].contentRect;
      this.setViewportSize(rect.width, rect.height);
    });
    this.resizeObserver.observe(viewportRef.nativeElement);

    // Deferred: the first redraw changes view-bound state already rendered this
    // pass (NG0100).
    setTimeout(() => {
      const r = this.viewportRef().nativeElement.getBoundingClientRect();
      this.setViewportSize(r.width, r.height);

      const frame = this.sequenceService.currentFrameImage();
      if (frame) this.loadImage(frame.imageBase64, frame.frame.width, frame.frame.height);
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    this.resizeObserver?.disconnect();
    clearTimeout(this.wheelDecayTimeout);
    clearTimeout(this.edgeRecomputeTimeout);
    if (this.bboxRecomputeTimer) clearTimeout(this.bboxRecomputeTimer);
  }

  private initSubscriptions() {
    this.orchestrator.redrawRequest
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.redrawAllCanvas());

    // A native tile finished loading. One redraw per frame.
    this.tiledImage.tileLoaded$
      .pipe(auditTime(0, animationFrameScheduler), takeUntil(this.destroy$))
      .subscribe(() => this.redrawAllCanvas());

    this.drawService.singleDrawRequest
      .pipe(takeUntil(this.destroy$))
      .subscribe(ctx => {
        if (ctx && this.ctxLabel) {
          // The stroke buffer, at its window origin, under the view transform.
          const origin = this.orchestrator.getBufferOrigin();
          this.applyLabelTransform();
          this.orchestrator.ensurePixelPerfectDrawing(this.ctxLabel);
          this.ctxLabel.drawImage(ctx.canvas, origin.x, origin.y);
          this.ctxLabel.resetTransform();
        }
      });
  }

  // ── Viewport sizing ──────────────────────────────────────────────────────

  private setViewportSize(width: number, height: number) {
    if (width === 0 || height === 0) return;
    if (width === this.viewportWidth && height === this.viewportHeight) return;

    this.viewportWidth = width;
    this.viewportHeight = height;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);

    const setCanvas = (c: HTMLCanvasElement) => {
      c.width = Math.round(width * this.dpr);
      c.height = Math.round(height * this.dpr);
      c.style.width = `${width}px`;
      c.style.height = `${height}px`;
    };
    setCanvas(this.imgCanvas().nativeElement);
    setCanvas(this.overlayCanvas().nativeElement);
    setCanvas(this.labelCanvas().nativeElement);

    this.orchestrator.setViewportSize(width, height);
    this.changeDetectorRef.detectChanges();

    this.orchestrator.requestRedraw();
  }

  @HostListener('window:resize')
  public onWindowResize() {
    // DPR changes, e.g. the window moved to another monitor.
    const newDpr = Math.max(1, window.devicePixelRatio || 1);
    if (newDpr !== this.dpr) {
      this.dpr = newDpr;
      const r = this.viewportRef().nativeElement.getBoundingClientRect();
      this.viewportWidth = 0; // force resize
      this.setViewportSize(r.width, r.height);
    }
  }

  // ── Image loading ────────────────────────────────────────────────────────

  public async loadImage(imageSrc: string, nativeWidth?: number, nativeHeight?: number) {
    try {
      await this.orchestrator.loadImage(imageSrc, nativeWidth, nativeHeight);
      const frameId = this.sequenceService.currentFrame()?.id;
      if (frameId != null && nativeWidth && nativeHeight) {
        this.tiledImage.setFrame(frameId, nativeWidth, nativeHeight);
      }
      this.svg().setViewBox(this.orchestrator.getSVGViewBox());
      this.vectorLayer()?.setViewBox(this.orchestrator.getSVGViewBox());
      this.changeDetectorRef.detectChanges();
    } catch (e) {
      console.error('Failed to load image:', e);
    }
  }

  // ── Input ────────────────────────────────────────────────────────────────

  public onMouseMove(data: { event: MouseEvent; coords: Point2D; cursor: Point2D }) {
    if (!this.orchestrator.image) return;

    this.cursor = data.cursor;
    this.zoomPanService.currentPixel = data.coords;

    const raw = this.zoomPanService.getImageCoordinatesRaw(data.event);
    this.isCursorInsideImage =
      raw.x >= 0 && raw.x < this.orchestrator.width &&
      raw.y >= 0 && raw.y < this.orchestrator.height;
    // Followed by the 3D view's shadow cursor.
    this.zoomPanService.cursorImage.set(this.isCursorInsideImage ? raw : null);

    if (this.editorService.canPan()) {
      this.orchestrator.pan(data.event);
    } else if (this.editorService.isVectorTool()) {
      this.vectorEditor.onPointerMove(raw, {
        shift: data.event.shiftKey,
        toggle: data.event.ctrlKey || data.event.metaKey,
      });
    } else if (this.editorService.isVectorizeTool()) {
    } else {
      this.drawService.draw(data.event);
    }
  }

  public onCursorLeave(): void {
    this.isCursorInsideImage = false;
    this.zoomPanService.cursorImage.set(null);
  }

  public wheel(event: WheelEvent): void {
    event.preventDefault();

    if (event.ctrlKey) {
      this.handleBrushSizeWheel(event);
      return;
    }

    // 3D mode: Shift+wheel scrolls through slices. Some platforms turn a shifted
    // wheel into horizontal scrolling, so either axis is read.
    if (event.shiftKey && this.volume.status() === 'ready') {
      const delta = event.deltaY || event.deltaX;
      if (delta !== 0) this.volume.sliceStepRequested$.next(Math.sign(delta));
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

  // ── Rendering ────────────────────────────────────────────────────────────

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
    if (!this.ctxImage || !this.ctxLabel) return;

    this.viewBox = this.orchestrator.getViewBox();
    this.svg().setViewBox(this.orchestrator.getSVGViewBox());
    this.vectorLayer()?.setViewBox(this.orchestrator.getSVGViewBox());

    this.clearDisplayCanvas(this.ctxImage);
    this.applyImageTransform();
    const processedImage = this.orchestrator.getProcessedImage();
    if (!processedImage) return;
    this.drawImageLayer(processedImage);
    this.ctxImage.resetTransform();

    // Overlays of experimental features, under the label layer's transform.
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

    // Label layer. Large images composite the visible region straight into the
    // display canvas; others draw the combined canvas.
    if (this.orchestrator.usesViewportComposite) {
      this.clearDisplayCanvas(this.ctxLabel);
      this.orchestrator.compositeLabelLayer(this.ctxLabel, this.dpr);
      // This path does not recompute the bounding boxes: do it here, debounced.
      if (this.stateService.recomputeCanvasSum) {
        this.stateService.recomputeCanvasSum = false;
        this.scheduleViewportBboxRecompute();
      }
    } else {
      // Recompute before clearing, so the previous frame stays visible meanwhile.
      const combined = await this.orchestrator.getCombinedLabelCanvas();
      this.clearDisplayCanvas(this.ctxLabel);
      if (combined) {
        this.applyLabelTransform();
        this.orchestrator.ensurePixelPerfectDrawing(this.ctxLabel);
        this.ctxLabel.drawImage(combined, 0, 0);
        this.ctxLabel.resetTransform();
      }
    }
  }

  /**
   * Draw the base image under the view transform. A large image has a display
   * pyramid: the level matched to the zoom is drawn, scaled up by the
   * transform.
   */
  private drawImageLayer(processedImage: CanvasImageSource): void {
    if (!this.ctxImage) return;

    const pyramid = this.orchestrator.displayPyramid;
    const scale = this.zoomPanService.getScale();
    const vpW = this.viewportWidth * this.dpr;
    const vpH = this.viewportHeight * this.dpr;

    // Past the finest stored level, draw the full-resolution source.
    if (pyramid && !this.pyramidService.needsNativeResolution(pyramid, scale, vpW, vpH)) {
      const level = this.pyramidService.getLevelForViewport(pyramid, scale, vpW, vpH);
      this.ctxImage.imageSmoothingEnabled = true;
      this.ctxImage.imageSmoothingQuality = 'high';
      this.ctxImage.drawImage(
        level.canvas,
        0, 0,
        this.orchestrator.width, this.orchestrator.height,
      );
    } else {
      this.ctxImage.imageSmoothingEnabled = false;
      this.ctxImage.drawImage(
        processedImage,
        0, 0,
        this.orchestrator.width, this.orchestrator.height,
      );
    }

    // Native tiles over the backdrop, where zoomed in.
    this.drawNativeTiles(scale);
  }

  /** Draw the cached native-resolution tiles of the visible region. */
  private drawNativeTiles(scale: number): void {
    if (!this.ctxImage || !this.orchestrator.usesViewportComposite) return;
    const frameId = this.sequenceService.currentFrame()?.id;
    if (frameId == null) return;

    const rect = this.orchestrator.getSVGViewBox(); // visible region, image space
    // Tiles get the image adjustments too, to match the backdrop.
    const adj = this.orchestrator.tileAdjustment();
    const tiles = this.tiledImage.tilesFor(rect, frameId, adj?.lut ?? null, adj?.version ?? 0);
    if (tiles.length === 0) return;

    // Smooth when the tile is shown smaller than native, crisp when magnified.
    this.ctxImage.imageSmoothingEnabled = scale < 1;
    this.ctxImage.imageSmoothingQuality = 'high';
    for (const t of tiles) {
      this.ctxImage.drawImage(t.bitmap, t.x, t.y);
    }
  }

  private bboxRecomputeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Recompute the bounding boxes on the large-image path, debounced. */
  private scheduleViewportBboxRecompute(): void {
    if (this.bboxRecomputeTimer) clearTimeout(this.bboxRecomputeTimer);
    this.bboxRecomputeTimer = setTimeout(() => {
      this.bboxRecomputeTimer = null;
      this.orchestrator.updateBoundingBoxes();
      this.changeDetectorRef.detectChanges(); // refresh the SVG overlay
    }, 300);
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

  // ── UI helpers ───────────────────────────────────────────────────────────

  public getCursorSize(): number {
    // Brush size in image px, to viewport CSS px, with the live pressure scaling.
    const pressureScale = this.stateService.isDrawing
      ? this.editorService.brushPressureScale()
      : 1;
    return this.editorService.lineWidth * pressureScale * this.zoomPanService.getScale();
  }

  public get isLoading(): boolean {
    return this.uiStateService.isLoading() || this.sequenceService.loading();
  }

  public getCursorStyle() {
    const size = this.getCursorSize();
    if (size <= 0) return {};

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

  // ── Ruler ticks ──────────────────────────────────────────────────────────

  /** A "nice" tick interval, in image px, putting major ticks about `targetPx`
   *  apart on screen. */
  private niceStepImg(targetPx: number): number {
    const scale = Math.max(this.zoomPanService.getScale(), 1e-6);
    const raw = targetPx / scale;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
    return nice * pow;
  }

  /** The tick-mark background of a ruler: minor ticks every fifth of a major
   *  step, offset by the image origin. */
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

  // ── Template getters ─────────────────────────────────────────────────────

  get hasImage(): boolean {
    return this.sequenceService.currentFrameImage() !== null;
  }

  get currentFrameName(): string | null {
    return this.sequenceService.currentFrame()?.relativePath ?? null;
  }
}