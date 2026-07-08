import { Injectable } from '@angular/core';
import { Point2D } from '../interface';
import { EditorService } from '../../services/editor.service';

@Injectable({ providedIn: 'root' })
export class StateManagerService {
  /** Image native dimensions (px). */
  public width = 0;
  public height = 0;

  public isDrawing = false;
  public currentPoint: Point2D = { x: -1, y: -1 };
  public previousPoint: Point2D = { x: -1, y: -1 };
  public minPoint: Point2D = { x: Number.MAX_VALUE, y: Number.MAX_VALUE };
  public maxPoint: Point2D = { x: 0, y: 0 };
  public recomputeCanvasSum = false;

  constructor(private editorService: EditorService) {}

  setWidthAndHeight(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  updatePreviousPoint(point: Point2D) { this.previousPoint = point; }
  updateCurrentPoint(point: Point2D) { this.currentPoint = point; }

  hasMoved(): boolean {
    return (
      this.currentPoint.x !== this.previousPoint.x ||
      this.currentPoint.y !== this.previousPoint.y
    );
  }

  isFirstStroke(): boolean {
    return this.previousPoint.x === -1 && this.previousPoint.y === -1;
  }

  resetMinMaxPoints() {
    this.minPoint = { x: Number.MAX_VALUE, y: Number.MAX_VALUE };
    this.maxPoint = { x: 0, y: 0 };
  }

  resetCurrentPoint() { this.currentPoint = { x: -1, y: -1 }; }
  resetPreviousPoint() { this.previousPoint = { x: -1, y: -1 }; }

  reset() {
    this.isDrawing = false;
    this.resetMinMaxPoints();
    this.resetPreviousPoint();
    this.resetCurrentPoint();
  }

  updateMinMaxPoints(point: Point2D) {
    const offset = this.getBrushSizeOffset();
    this.minPoint = {
      x: Math.max(0, Math.min(this.minPoint.x, point.x - offset)),
      y: Math.max(0, Math.min(this.minPoint.y, point.y - offset)),
    };
    this.maxPoint = {
      x: Math.min(this.width,  Math.max(this.maxPoint.x, point.x + offset)),
      y: Math.min(this.height, Math.max(this.maxPoint.y, point.y + offset)),
    };
  }

  getBoundingBox() {
    return {
      x: this.minPoint.x,
      y: this.minPoint.y,
      width:  Math.max(0, this.maxPoint.x - this.minPoint.x),
      height: Math.max(0, this.maxPoint.y - this.minPoint.y),
    };
  }

  getBrushSizeOffset(): number {
    if (!this.editorService.isToolWithBrushSize()) return 0;
    // Match the *actual* drawn radius: in pressure/touch mode the brush is
    // scaled per point by brushPressureScale(), so the bbox padding must use the
    // same scaled radius (read live here, identical to the value the tool uses
    // in the same draw() call) — otherwise wider points fall outside the box and
    // get clipped on commit.
    const radius =
      (this.editorService.lineWidth * this.editorService.brushPressureScale()) / 2;
    return radius + 2;
  }

  getStateSnapshot() {
    return {
      width: this.width,
      height: this.height,
      isDrawing: this.isDrawing,
      currentPoint: this.currentPoint,
      previousPoint: this.previousPoint,
      minPoint: this.minPoint,
      maxPoint: this.maxPoint,
      recomputeCanvasSum: this.recomputeCanvasSum,
    };
  }
}