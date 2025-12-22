import { Injectable } from '@angular/core';
import { Point2D, Rect, Viewbox } from '../interface';
import { Subject } from 'rxjs';
import { StateManagerService } from './state-manager.service';

@Injectable({
  providedIn: 'root',
})
export class ZoomPanService {
  public isDragging = false;
  public scale = 1;
  public offset: Point2D = { x: 0, y: 0 };
  public maxScale = 30;
  public minScale = 0.1;
  private targetScale = 1;
  private targetOffset: Point2D = { x: 0, y: 0 };
  public currentPixel: Point2D = { x: 0, y: 0 };
  private canZoom = true;
  private canPan = true;
  private canvasRef: HTMLCanvasElement;
  smooth: boolean = true;
  private prevPoint: Point2D | null = null;
  public redrawRequest = new Subject<boolean>();
  constructor(private stateService: StateManagerService) {}

  public setContext(canvasRef: HTMLCanvasElement) {
    this.canvasRef = canvasRef;
  }

  getViewBox(): Viewbox {
    if (!this.canvasRef) {
      return {
        xmin: 0,
        ymin: 0,
        xmax: 0,
        ymax: 0,
      };
    }
    // Return computed viewBox

    let rect = this.canvasRef.getBoundingClientRect();

    let canvasScale = rect.width / this.stateService.width;
    let xmin = Math.round(this.offset.x * canvasScale);
    let xmax = xmin + this.stateService.width * this.scale * canvasScale;
    let ymin = Math.round(this.offset.y * canvasScale);
    let ymax = ymin + this.stateService.height * this.scale * canvasScale;

    return { xmin: xmin, ymin: ymin, xmax: xmax, ymax: ymax };
  }

  getSVGViewBox(): Rect {
    const viewBoxX = -this.offset.x / this.scale;
    const viewBoxY = -this.offset.y / this.scale;
    const viewBoxWidth = this.stateService.width / this.scale;
    const viewBoxHeight = this.stateService.width / this.scale;
    return {
      x: viewBoxX,
      y: viewBoxY,
      width: viewBoxWidth,
      height: viewBoxHeight,
    };
  }

  public drag(event: MouseEvent) {
    if (!this.canPan) {
      return;
    }
    if (this.isDragging) {
      if (!this.prevPoint) {
        return;
      }

      const canvas = this.canvasRef;
      const rect = canvas.getBoundingClientRect();

      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;

      const dx = (event.clientX - this.prevPoint.x) * scaleX;
      const dy = (event.clientY - this.prevPoint.y) * scaleY;

      this.targetOffset.x += dx;
      this.targetOffset.y += dy;
      this.offset.x += dx;
      this.offset.y += dy;
      requestAnimationFrame(() => {
        this.redrawRequest.next(true);
      });
      this.prevPoint = { x: event.clientX, y: event.clientY };
    }
  }

  public endDrag() {
    this.isDragging = false;
    this.prevPoint = null;
  }

  public fromCanvasToImageCoordinates(point: Point2D): Point2D {
    const imageX = (point.x - this.offset.x) / this.scale;
    const imageY = (point.y - this.offset.y) / this.scale;
    return { x: Math.round(imageX), y: Math.round(imageY) };
  }

  public getCanvasCoordinates(
    event: MouseEvent | WheelEvent | Point2D
  ): Point2D {
    const clientX = (event as MouseEvent).clientX
      ? (event as MouseEvent).clientX
      : (event as Point2D).x;
    const clientY = (event as MouseEvent).clientY
      ? (event as MouseEvent).clientY
      : (event as Point2D).y;

    const rect = this.canvasRef.getBoundingClientRect();
    const scaleX = this.canvasRef.width / rect.width;
    const scaleY = this.canvasRef.height / rect.height;

    const x = Math.round((clientX - rect.left) * scaleX);
    const y = Math.round((clientY - rect.top) * scaleY);

    return { x, y };
  }

  public getImageCoordinates(
    event: MouseEvent | WheelEvent | Point2D
  ): Point2D {
    const clientX = (event as MouseEvent).clientX
      ? (event as MouseEvent).clientX
      : (event as Point2D).x;
    const clientY = (event as MouseEvent).clientY
      ? (event as MouseEvent).clientY
      : (event as Point2D).y;

    const rect = this.canvasRef.getBoundingClientRect();
    const scaleX = this.canvasRef.width / rect.width;
    const scaleY = this.canvasRef.height / rect.height;

    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;

    let imageX = (x - this.offset.x) / this.scale;
    let imageY = (y - this.offset.y) / this.scale;
    imageX = Math.min(this.stateService.width - 1, Math.max(0, imageX));
    imageY = Math.min(this.stateService.height - 1, Math.max(0, imageY));

    return { x: Math.round(imageX), y: Math.round(imageY) };
  }

  public getTransform() {
    return {
      scale: this.targetScale,
      offsetX: this.targetOffset.x,
      offsetY: this.targetOffset.y,
    };
  }

  public setTransform(
    scale: number,
    offsetX: number,
    offsetY: number,
    smooth: boolean = true
  ) {
    this.targetScale = scale;
    this.targetOffset.x = offsetX;
    this.targetOffset.y = offsetY;
    if (smooth && this.smooth) {
      this.smoothUpdateTransform();
    } else {
      this.redrawRequest.next(true);
    }
  }

  public resetZoomAndPan(smooth: boolean = true, redraw: boolean = true) {
     // CRITICAL: Check if context is initialized
    if (!this.canvasRef) {
      return;
    }
    this.stateService.recomputeCanvasSum = false;
    // Compute the target scale and offset to fit the image to the canvas
    // Use actual canvas dimensions, not the bounding rect
    const canvasWidth = this.canvasRef.width;
    const canvasHeight = this.canvasRef.height;

    // Calculate scale to fit image within canvas
    let scaleX = canvasWidth / this.stateService.width;
    let scaleY = canvasHeight / this.stateService.height;
    this.targetScale = Math.max(scaleX, scaleY);
    this.targetScale = Math.min(this.targetScale, this.maxScale);
    this.targetScale = Math.max(this.targetScale, this.minScale);

    // Center the image on the canvas
    const offsetX =
      (canvasWidth - this.stateService.width * this.targetScale) / 2;
    const offsetY =
      (canvasHeight - this.stateService.height * this.targetScale) / 2;
    this.targetOffset = { x: offsetX, y: offsetY };
    if (!redraw) {
      return;
    }

    if (smooth && this.smooth) {
      this.smoothUpdateTransform();
    } else {
      this.scale = this.targetScale;
      this.offset = this.targetOffset;
      this.redrawRequest.next(true);
    }
  }

  public smoothUpdateTransform() {
    if (!this.smooth) {
      this.scale = this.targetScale;
      this.offset = this.targetOffset;
      this.redrawRequest.next(true);
      return;
    }
    const easeFactorZoom = 0.3;
    const newScale =
      this.scale + (this.targetScale - this.scale) * easeFactorZoom;
    const newOffsetX =
      this.offset.x + (this.targetOffset.x - this.offset.x) * easeFactorZoom;
    const newOffsetY =
      this.offset.y + (this.targetOffset.y - this.offset.y) * easeFactorZoom;

    if (
      Math.abs(this.targetScale - newScale) > 0.05 ||
      Math.abs(this.targetOffset.x - newOffsetX) > 1 ||
      Math.abs(this.targetOffset.y - newOffsetY) > 1
    ) {
      this.scale = newScale;
      this.offset.x = newOffsetX;
      this.offset.y = newOffsetY;
      requestAnimationFrame(() => {
        this.stateService.recomputeCanvasSum = false;
        this.smoothUpdateTransform();
        this.redrawRequest.next(true);
      });
    }
  }

  public startDrag(event: MouseEvent) {
    this.prevPoint = { x: event.clientX, y: event.clientY };
    this.isDragging = true;
  }

  public wheel(event: WheelEvent) {
    if (!this.canZoom) {
      return;
    }
    event.preventDefault();
    const zoomIntensity = 0.25;
    const wheel = event.deltaY < 0 ? 1 : -1;
    const zoom = Math.exp(wheel * zoomIntensity);

    const canvasCoord = this.getCanvasCoordinates(event);
    const imageCoord = this.fromCanvasToImageCoordinates(canvasCoord);

    this.targetScale *= zoom;
    this.targetScale = Math.min(this.targetScale, this.maxScale);
    this.targetScale = Math.max(this.targetScale, this.minScale);
    this.targetOffset.x = canvasCoord.x - imageCoord.x * this.targetScale;
    this.targetOffset.y = canvasCoord.y - imageCoord.y * this.targetScale;
    this.smoothUpdateTransform();
  }

  getScale() {
    return this.scale;
  }

  getOffset() {
    return this.offset;
  }

  zoomIn(factor: number) {
    this.targetScale *= factor;
    this.targetScale = Math.min(this.targetScale, this.maxScale);
    this.targetOffset.x =
      this.currentPixel.x - this.currentPixel.x * this.targetScale;
    this.targetOffset.y =
      this.currentPixel.y - this.currentPixel.y * this.targetScale;

    this.smoothUpdateTransform();
  }

  zoomOut(factor: number) {
    this.targetScale /= factor;
    this.targetScale = Math.max(this.targetScale, this.minScale);
    this.targetOffset.x =
      this.currentPixel.x - this.currentPixel.x * this.targetScale;
    this.targetOffset.y =
      this.currentPixel.y - this.currentPixel.y * this.targetScale;
    this.smoothUpdateTransform();
  }
}
