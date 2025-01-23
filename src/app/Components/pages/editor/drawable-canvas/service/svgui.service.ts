import { Injectable } from '@angular/core';
import { Point2D } from '../models';

@Injectable({
  providedIn: 'root'
})
export class SVGUIService {

  eraserPath: Point2D[] = [];
  linePath: Point2D[] = [];

  constructor() {

  }
  getEraserPathasSVG(): string {
    let path = '';

    if (this.eraserPath.length < 2) {
      return path;
    }

    path += `M${this.eraserPath[0].x} ${this.eraserPath[0].y} `;
    for (let i = 1; i < this.eraserPath.length; i += 1) {
      path += `L${this.eraserPath[i].x} ${this.eraserPath[i].y} `;
    }
    return path;
  }

  getLinePathasSVG(): string {
    let path = '';

    if (this.linePath.length < 2) {
      return path;
    }

    path += `M${this.linePath[0].x} ${this.linePath[0].y} `;
    for (let i = 1; i < this.linePath.length; i += 1) {
      path += `L${this.linePath[i].x} ${this.linePath[i].y} `;
    }
    return path;
  }

  resetPath() {
    this.eraserPath = [];
    this.linePath = [];
  }

  addPoint(point: Point2D) {
    this.eraserPath.push(point);
  }

}
