import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { Point2D, Rect, Viewbox } from '../interface';
import { StateManagerService } from './state-manager.service';

@Injectable({ providedIn: 'root' })
export class ZoomPanService {
  // === View transform (CSS px space) ===
  /** CSS px per image px. */
  public scale = 1;
  /** Image origin in viewport CSS px. */
  public offset: Point2D = { x: 0, y: 0 };

  private targetScale = 1;
  private targetOffset: Point2D = { x: 0, y: 0 };

  public minScale = 0.05;
  public maxScale = 64;
  public smooth = true;

  // === Viewport (CSS px) ===
  private viewportWidth = 0;
  private viewportHeight = 0;
  private viewportRef: HTMLElement | null = null;

  // === Pan state ===
  public isDragging = false;
  private prevClient: Point2D | null = null;

  /** Last image-space cursor, kept for the rulers. */
  public currentPixel: Point2D = { x: 0, y: 0 };

  private canZoom = true;
  private canPan = true;

  public redrawRequest = new Subject<boolean>();

  constructor(private stateService: StateManagerService) {}

  // ==========================================
  // Setup
  // ==========================================

  /** The element whose bounding rect is used for client→viewport math. */
  public setViewportRef(el: HTMLElement) {
    this.viewportRef = el;
  }

  /** Pushed by a ResizeObserver in the component. */
  public setViewportSize(width: number, height: number) {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /** @deprecated Kept for callers still passing a canvas. */
  public setContext(canvasRef: HTMLCanvasElement) {
    this.setViewportRef(canvasRef);
  }

  // ==========================================
  // Coordinate conversions
  // ==========================================

  /** Pointer position in viewport CSS px (relative to viewport top-left). */
  public getViewportCoordinates(event: MouseEvent | WheelEvent | Point2D): Point2D {
    const { clientX, clientY } = this.getClientCoords(event);
    if (!this.viewportRef) return { x: clientX, y: clientY };
    const rect = this.viewportRef.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /** Pointer position in image px, clamped to image bounds, integer. */
  public getImageCoordinates(event: MouseEvent | WheelEvent | Point2D): Point2D {
    const vp = this.getViewportCoordinates(event);
    const ix = (vp.x - this.offset.x) / this.scale;
    const iy = (vp.y - this.offset.y) / this.scale;
    return {
      x: Math.round(Math.min(this.stateService.width - 1, Math.max(0, ix))),
      y: Math.round(Math.min(this.stateService.height - 1, Math.max(0, iy))),
    };
  }

  /** Same as above but float and unclamped. */
  public getImageCoordinatesRaw(event: MouseEvent | WheelEvent | Point2D): Point2D {
    const vp = this.getViewportCoordinates(event);
    return {
      x: (vp.x - this.offset.x) / this.scale,
      y: (vp.y - this.offset.y) / this.scale,
    };
  }

  public viewportToImage(p: Point2D): Point2D {
    return {
      x: (p.x - this.offset.x) / this.scale,
      y: (p.y - this.offset.y) / this.scale,
    };
  }

  public imageToViewport(p: Point2D): Point2D {
    return {
      x: p.x * this.scale + this.offset.x,
      y: p.y * this.scale + this.offset.y,
    };
  }

  /** @deprecated alias of getViewportCoordinates. */
  public getCanvasCoordinates(event: MouseEvent | WheelEvent | Point2D): Point2D {
    return this.getViewportCoordinates(event);
  }

  // ==========================================
  // Transform application
  // ==========================================

  /**
   * Apply the view transform to a display canvas context.
   * After this call, drawing happens in image-space coordinates,
   * mapped through view-scale and DPR. Offsets are snapped to integer
   * CSS px to keep pixels crisp at integer zooms.
   */
  public applyViewTransform(ctx: CanvasRenderingContext2D, dpr: number) {
    const ox = Math.round(this.offset.x);
    const oy = Math.round(this.offset.y);
    ctx.setTransform(
      this.scale * dpr, 0,
      0, this.scale * dpr,
      ox * dpr, oy * dpr
    );
  }

  // ==========================================
  // Viewbox getters
  // ==========================================

  /** Where the image sits in viewport CSS px. Used by the rulers. */
  public getViewBox(): Viewbox {
    return {
      xmin: Math.round(this.offset.x),
      ymin: Math.round(this.offset.y),
      xmax: Math.round(this.offset.x + this.stateService.width * this.scale),
      ymax: Math.round(this.offset.y + this.stateService.height * this.scale),
    };
  }

  /** SVG viewBox in image space, sized to the full viewport. */
  public getSVGViewBox(): Rect {
    if (this.scale <= 0) return { x: 0, y: 0, width: 1, height: 1 };
    return {
      x: -this.offset.x / this.scale,
      y: -this.offset.y / this.scale,
      width: this.viewportWidth / this.scale,
      height: this.viewportHeight / this.scale,
    };
  }

  // ==========================================
  // Pan
  // ==========================================

  public startDrag(event: MouseEvent) {
    if (!this.canPan) return;
    this.prevClient = { x: event.clientX, y: event.clientY };
    this.isDragging = true;
  }

  public drag(event: MouseEvent) {
    if (!this.canPan || !this.isDragging || !this.prevClient) return;
    const dx = event.clientX - this.prevClient.x;
    const dy = event.clientY - this.prevClient.y;
    this.targetOffset.x += dx;
    this.targetOffset.y += dy;
    this.offset.x += dx;
    this.offset.y += dy;
    this.prevClient = { x: event.clientX, y: event.clientY };
    this.redrawRequest.next(true);
  }

  public endDrag() {
    this.isDragging = false;
    this.prevClient = null;
  }

  // ==========================================
  // Zoom
  // ==========================================

  public wheel(event: WheelEvent) {
    if (!this.canZoom) return;
    event.preventDefault();
    const intensity = 0.25;
    const dir = event.deltaY < 0 ? 1 : -1;
    const factor = Math.exp(dir * intensity);
    const pivot = this.getViewportCoordinates(event);
    this.zoomAt(pivot, factor);
  }

  public zoomIn(factor: number) {
    this.zoomAt(this.getViewportCenter(), factor);
  }

  public zoomOut(factor: number) {
    this.zoomAt(this.getViewportCenter(), 1 / factor);
  }

  /**
   * Zoom by `factor`, keeping `pivotViewport` (in viewport CSS px) stationary.
   * This is the only place that should compute offset from a zoom event.
   */
  private zoomAt(pivotViewport: Point2D, factor: number) {
    const pivotImage = this.viewportToImage(pivotViewport);
    let newScale = this.targetScale * factor;
    newScale = Math.min(this.maxScale, Math.max(this.minScale, newScale));
    this.targetScale = newScale;
    this.targetOffset.x = pivotViewport.x - pivotImage.x * newScale;
    this.targetOffset.y = pivotViewport.y - pivotImage.y * newScale;
    this.smoothUpdateTransform();
  }

  private getViewportCenter(): Point2D {
    return { x: this.viewportWidth / 2, y: this.viewportHeight / 2 };
  }

  // ==========================================
  // Reset / fit
  // ==========================================

  public resetZoomAndPan(smooth: boolean = true, redraw: boolean = true) {
    if (this.viewportWidth === 0 || this.viewportHeight === 0) return;
    const imgW = this.stateService.width;
    const imgH = this.stateService.height;
    if (imgW === 0 || imgH === 0) return;

    this.stateService.recomputeCanvasSum = false;

    const fit = Math.min(this.viewportWidth / imgW, this.viewportHeight / imgH);
    this.targetScale = Math.min(this.maxScale, Math.max(this.minScale, fit));
    this.targetOffset = {
      x: (this.viewportWidth - imgW * this.targetScale) / 2,
      y: (this.viewportHeight - imgH * this.targetScale) / 2,
    };

    if (!redraw) return;

    if (smooth && this.smooth) {
      this.smoothUpdateTransform();
    } else {
      this.scale = this.targetScale;
      this.offset = { ...this.targetOffset };
      this.redrawRequest.next(true);
    }
  }

  public setTransform(scale: number, offsetX: number, offsetY: number, smooth: boolean = true) {
    this.targetScale = Math.min(this.maxScale, Math.max(this.minScale, scale));
    this.targetOffset = { x: offsetX, y: offsetY };
    if (smooth && this.smooth) {
      this.smoothUpdateTransform();
    } else {
      this.scale = this.targetScale;
      this.offset = { ...this.targetOffset };
      this.redrawRequest.next(true);
    }
  }

  public getTransform() {
    return {
      scale: this.targetScale,
      offsetX: this.targetOffset.x,
      offsetY: this.targetOffset.y,
    };
  }

  // ==========================================
  // Smooth interpolation
  // ==========================================

  public smoothUpdateTransform() {
    if (!this.smooth) {
      this.scale = this.targetScale;
      this.offset = { ...this.targetOffset };
      this.redrawRequest.next(true);
      return;
    }
    const ease = 0.3;
    const newScale = this.scale + (this.targetScale - this.scale) * ease;
    const newOx = this.offset.x + (this.targetOffset.x - this.offset.x) * ease;
    const newOy = this.offset.y + (this.targetOffset.y - this.offset.y) * ease;

    const dS = Math.abs(this.targetScale - newScale);
    const dx = Math.abs(this.targetOffset.x - newOx);
    const dy = Math.abs(this.targetOffset.y - newOy);

    if (dS > 0.001 || dx > 0.5 || dy > 0.5) {
      this.scale = newScale;
      this.offset.x = newOx;
      this.offset.y = newOy;
      this.redrawRequest.next(true);
      requestAnimationFrame(() => {
        this.stateService.recomputeCanvasSum = false;
        this.smoothUpdateTransform();
      });
    } else {
      this.scale = this.targetScale;
      this.offset = { ...this.targetOffset };
      this.redrawRequest.next(true);
    }
  }

  // ==========================================
  // Getters
  // ==========================================

  public getScale(): number { return this.scale; }
  public getOffset(): Point2D { return this.offset; }
  public getViewportWidth(): number { return this.viewportWidth; }
  public getViewportHeight(): number { return this.viewportHeight; }

  // ==========================================
  // Internal
  // ==========================================

  private getClientCoords(event: MouseEvent | WheelEvent | Point2D): { clientX: number; clientY: number } {
    if ('clientX' in event && typeof (event as MouseEvent).clientX === 'number') {
      return { clientX: (event as MouseEvent).clientX, clientY: (event as MouseEvent).clientY };
    }
    const p = event as Point2D;
    return { clientX: p.x, clientY: p.y };
  }
}