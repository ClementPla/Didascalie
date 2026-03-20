import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  ViewChild,
  HostListener,
  OnDestroy,
  effect,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

// UI Services
import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { SequenceService } from '../../../../../Services/sequence.service';

// Orchestrator + Draw
import { OrchestratorService } from '../service/orchestrator.service';
import { DrawService } from '../service/draw.service';
import { ZoomPanService } from '../service/zoom-pan.service';

// Components & Directives
import { SVGElementsComponent } from './svgelements/svgelements.component';
import { CanvasInputDirective } from '../directives/canvas-input.directive';
import { Button } from 'primeng/button';

import { Point2D, Viewbox } from '../interface';
import { UIStateService } from '../../../../../Services/uistate.service';

@Component({
  selector: 'app-drawable-canvas',
  imports: [CommonModule, FormsModule, Button, SVGElementsComponent, CanvasInputDirective],
  templateUrl: './drawable-canvas.component.html',
  styleUrl: './drawable-canvas.component.scss',
  standalone: true,
})
export class DrawableCanvasComponent implements AfterViewInit, OnDestroy {
  // View state
  public cursor: Point2D = { x: 25, y: 25 };
  public viewBox: Viewbox = { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
  public isFullscreen: boolean = false;
  public rulerSize: number = 16;

  // Canvas sizing
  public canvasWidth = 1;
  public canvasHeight = 1;
  public canvasLeft = 0;
  public canvasTop = 0;

  // Contexts
  private ctxImage: CanvasRenderingContext2D | null = null;
  private ctxLabel: CanvasRenderingContext2D | null = null;

  // Brush size wheel acceleration
  private lastWheelTime = 0;
  private wheelVelocity = 0;
  private wheelDecayTimeout?: number;

  // Cleanup
  private edgeRecomputeTimeout?: number;
  private destroy$ = new Subject<void>();

  @ViewChild('imageCanvas') public imgCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('labelCanvas') public labelCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('svg') public svg: SVGElementsComponent;

  constructor(
    public editorService: EditorService,
    public labelService: LabelsService,
    public sequenceService: SequenceService,
    public orchestrator: OrchestratorService,
    private drawService: DrawService,
    public zoomPanService: ZoomPanService,
    private changeDetectorRef: ChangeDetectorRef,
    private uiStateService: UIStateService
  ) {
    this.initSubscriptions();

    // React to frame image changes
    effect(() => {
      const frameImage = this.sequenceService.currentFrameImage();
      if (frameImage && this.ctxImage) {
        this.loadImage(frameImage.image_base64);
      }
    });
  }

  ngAfterViewInit() {
    this.ctxImage = this.imgCanvas.nativeElement.getContext('2d', { alpha: false })!;
    this.ctxLabel = this.labelCanvas.nativeElement.getContext('2d', { alpha: true })!;

    this.orchestrator.setCanvasContext(this.imgCanvas.nativeElement);

    // Load initial image if available
    const frameImage = this.sequenceService.currentFrameImage();
    if (frameImage) {
      this.loadImage(frameImage.image_base64);
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    clearTimeout(this.wheelDecayTimeout);
    clearTimeout(this.edgeRecomputeTimeout);
  }

  private initSubscriptions() {
    // Single subscription for all redraw events
    this.orchestrator.redrawRequest
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.redrawAllCanvas());

    // Single draw request (for buffer canvas)
    this.drawService.singleDrawRequest
      .pipe(takeUntil(this.destroy$))
      .subscribe((ctx) => {
        if (ctx && this.ctxLabel) {
          this.ctxLabel.drawImage(ctx.canvas, 0, 0);
        }
      });
  }

  // ==========================================
  // Image Loading
  // ==========================================

  public async loadImage(imageSrc: string) {
    try {
      const img = await this.orchestrator.loadImage(imageSrc);
      this.initializeCanvasDimensions(img);
    } catch (error) {
      console.error('Failed to load image:', error);
    }
  }

  private initializeCanvasDimensions(img: HTMLImageElement) {
    // Set canvas element dimensions
    this.imgCanvas.nativeElement.width = img.width;
    this.imgCanvas.nativeElement.height = img.height;
    this.labelCanvas.nativeElement.width = img.width;
    this.labelCanvas.nativeElement.height = img.height;

    // Set SVG viewbox
    this.svg.setViewBox({ x: 0, y: 0, width: img.width, height: img.height });

    this.resizeCanvas();
    this.changeDetectorRef.detectChanges();
  }

  // ==========================================
  // Canvas Sizing
  // ==========================================

  @HostListener('window:resize')
  public resizedWindow() {
    this.resizeCanvas();
  }

  public resizeCanvas() {
    const width = this.orchestrator.width;
    const height = this.orchestrator.height;
    if (width === 0 || height === 0) return;

    const aspectRatio = width / height;
    const parentElement = this.imgCanvas.nativeElement.parentElement?.parentElement;

    if (!parentElement) {
      console.error('Parent element not found');
      return;
    }

    const parentWidth = parentElement.clientWidth || 0;
    const parentHeight = parentElement.clientHeight || 0;

    let newWidth = parentWidth;
    let newHeight = parentWidth / aspectRatio;

    if (newHeight > parentHeight) {
      newHeight = parentHeight;
      newWidth = parentHeight * aspectRatio;
    }

    this.canvasWidth = newWidth;
    this.canvasHeight = newHeight;

    this.changeDetectorRef.detectChanges();

    const canvasRect = this.imgCanvas.nativeElement.getBoundingClientRect();
    const parentRect = parentElement.getBoundingClientRect();

    this.canvasLeft = canvasRect.left - parentRect.left;
    this.canvasTop = canvasRect.top - parentRect.top;
  }

  // ==========================================
  // Input Handlers
  // ==========================================

  public onMouseMove(data: { event: MouseEvent; coords: Point2D; cursor: Point2D }) {
    if (!this.orchestrator.image) return;

    this.cursor = data.cursor;
    this.zoomPanService.currentPixel = data.coords;

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
    // Recompute edges after zoom settles
    if (this.editorService.edgesOnly) {
      clearTimeout(this.edgeRecomputeTimeout);
      this.edgeRecomputeTimeout = window.setTimeout(() => {
        this.orchestrator.requestRedrawAllCanvas(); // This will trigger edge recomputation in the CanvasManager service to adjust to the new zoom level
      }, 150);
    }
  }

  private handleBrushSizeWheel(event: WheelEvent) {
    const now = performance.now();
    const timeDelta = now - this.lastWheelTime;

    if (timeDelta < 100) {
      this.wheelVelocity = Math.min(this.wheelVelocity + 1, 25);
    } else if (timeDelta > 200) {
      this.wheelVelocity = 0;
    }

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
    const img = this.orchestrator.image;
    if (!img || !img.complete || img.naturalWidth === 0) {
      console.warn('Image not loaded yet, skipping redraw.');
      return;
    }

    if (!this.ctxImage || !this.ctxLabel) {
      console.error('Canvas contexts not initialized.');
      return;
    }

    this.viewBox = this.orchestrator.getViewBox();
    this.svg.setViewBox(this.orchestrator.getSVGViewBox());

    const { scale, offset } = this.orchestrator.getViewTransform();
    const width = this.orchestrator.width;
    const height = this.orchestrator.height;

    // Draw image canvas
    this.ctxImage.resetTransform();
    this.ctxImage.clearRect(0, 0, this.ctxImage.canvas.width, this.ctxImage.canvas.height);
    this.ctxImage.translate(Math.floor(offset.x), Math.floor(offset.y));
    this.ctxImage.scale(scale, scale);
    this.ctxImage.imageSmoothingEnabled = false;
    this.ctxImage.drawImage(this.orchestrator.getProcessedImage(), 0, 0, width, height);

    const combinedLabelCanvas = await this.orchestrator.getCombinedLabelCanvas();

    // Draw label canvas
    this.ctxLabel.resetTransform();
    this.ctxLabel.clearRect(0, 0, this.ctxLabel.canvas.width, this.ctxLabel.canvas.height);
    this.ctxLabel.translate(Math.floor(offset.x), Math.floor(offset.y));
    this.ctxLabel.scale(scale, scale);
    this.orchestrator.ensurePixelPerfectDrawing(this.ctxLabel);
    this.ctxLabel.drawImage(combinedLabelCanvas, 0, 0);
  }

  // ==========================================
  // Public API (for parent components)
  // ==========================================

  public loadCanvas(data: string, index: number) {
    this.orchestrator.loadCanvas(data, index);
  }

  public async loadAllCanvas(masks: string[]) {
    await this.orchestrator.loadAllCanvas(masks);
  }

  public switchFullScreen() {
    this.isFullscreen = !this.isFullscreen;
    if (!this.isFullscreen) {
      this.orchestrator.resetView(true, true);
    }
  }

  // ==========================================
  // UI Helpers
  // ==========================================

  public getCursorSize(): number {
    if (!this.ctxLabel) return 0;

    const rect = this.ctxLabel.canvas.getBoundingClientRect();
    const { scale } = this.orchestrator.getViewTransform();

    const domScaleX = rect.width / this.ctxLabel.canvas.width;
    const domScaleY = rect.height / this.ctxLabel.canvas.height;
    const domScale = (domScaleX + domScaleY) / 2;
    return this.editorService.lineWidth * scale * domScale;
  }

  public get isLoading(): boolean {
    return this.uiStateService.isLoading || this.sequenceService.loading();
  }

  public getCursorStyle() {
  const cursorSize = this.getCursorSize();
  if (cursorSize <= 0) return {};

  // Account for canvas scaling (CSS size vs internal resolution)
  const rect = this.imgCanvas.nativeElement.getBoundingClientRect();
  const canvas = this.imgCanvas.nativeElement;
  
  // Get the transform from zoom/pan
  const { scale, offset } = this.orchestrator.getViewTransform();
  
  // Calculate DOM scale (CSS pixels to canvas pixels)
  const domScaleX = rect.width / canvas.width;
  const domScaleY = rect.height / canvas.height;
  
  // Get image coordinates (where brush actually draws)
  const imageCoords = this.zoomPanService.currentPixel;
  
  // Transform image coordinates back to DOM coordinates
  const cursorX = (imageCoords.x * scale + offset.x) * domScaleX;
  const cursorY = (imageCoords.y * scale + offset.y) * domScaleY;

  return {
    'left.px': cursorX,
    'top.px': cursorY,
    'width.px': cursorSize,
    'height.px': cursorSize,
    'margin-left.px': -cursorSize / 2,
    'margin-top.px': -cursorSize / 2,
    'border-color': this.labelService.activeLabel?.color,
  };
}

  public getCSSFilterEdge(): string {
    return this.editorService.edgesOnly
      ? 'drop-shadow( 1px  0px 0px black) drop-shadow(-1px  0px 0px black) drop-shadow( 0px  1px 0px black) drop-shadow( 0px -1px 0px black)'
      : '';
  }

  // ==========================================
  // Getters for Template
  // ==========================================

  get hasImage(): boolean {
    return this.sequenceService.currentFrameImage() !== null;
  }

  get currentFrameName(): string | null {
    const frame = this.sequenceService.currentFrame();
    return frame?.relative_path ?? null;
  }
}