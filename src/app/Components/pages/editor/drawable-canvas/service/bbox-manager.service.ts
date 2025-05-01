import { Injectable } from '@angular/core';
import { BboxLabel, SegLabel } from '../../../../../Core/interface';
import { Rect } from '../models';




@Injectable({
  providedIn: 'root'
})
export class BboxManagerService {

  listBbox: BboxLabel[] = [];

  constructor() {
  }

  clear() {
    this.listBbox = [];
  }
  addBboxes(bboxes: Rect[], label: SegLabel) {
    bboxes.forEach((bbox, index) => {
      this.listBbox.push({
        label: label,
        bbox: bbox,
        instance: index
      });
    });

  }

}
