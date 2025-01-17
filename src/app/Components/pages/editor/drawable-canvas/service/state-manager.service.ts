import { Injectable } from '@angular/core';
import { Point2D } from '../models';
import { EditorService } from '../../../../../Services/UI/editor.service';

@Injectable({
  providedIn: 'root'
})
export class StateManagerService {

  public width: number = 512;
  public height: number = 512;

  public isDrawing: boolean = false;

  public currentPoint: Point2D = { x: -1, y: -1 };
  public previousPoint: Point2D = { x: -1, y: -1 };

  public minPoint: Point2D = { x: Number.MAX_VALUE, y: Number.MAX_VALUE };
  public maxPoint: Point2D = { x: 0, y: 0 };

  public recomputeCanvasSum: boolean = false;


  constructor(private editorService: EditorService) { }

  updatePreviousPoint(point: Point2D) {
    this.previousPoint = point;
  }

  updateCurrentPoint(point: Point2D) {
    this.currentPoint = point;
  }

  setWidthAndHeight(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  resetMinMaxPoints() {
    this.minPoint = { x: Number.MAX_VALUE, y: Number.MAX_VALUE };
    this.maxPoint = { x: 0, y: 0 };
  }

  resetCurrentPoint() {
    this.currentPoint = { x: -1, y: -1 };
  }

  resetPreviousPoint() {
    this.previousPoint = { x: -1, y: -1 };
  }

  reset() {
    this.isDrawing = false;
    this.resetMinMaxPoints();
    this.resetPreviousPoint();
    this.resetCurrentPoint();
  }

  isFirstStroke() {
    return this.previousPoint.x === -1 && this.previousPoint.y === -1;
  }

  updateMinMaxPoints(point: Point2D) {
    const offset = this.getBrushSizeOffset();
    this.minPoint = {
      x: Math.max(0, Math.min(this.minPoint.x, point.x - offset)),
      y: Math.max(0, Math.min(this.minPoint.y, point.y - offset))
    };
    this.maxPoint = {
      x: Math.max(this.maxPoint.x, point.x + offset),
      y: Math.max(this.maxPoint.y, point.y + offset)
    };
  }

  getBoundingBox() {
    return {
      x: this.minPoint.x,
      y: this.minPoint.y,
      width: this.maxPoint.x - this.minPoint.x,
      height: this.maxPoint.y - this.minPoint.y,
    };
  }



  getBrushSizeOffset() {

    return this.editorService.isToolWithBrushSize()
      ? this.editorService.lineWidth / 2 + 2
      : 0;

  }




}
