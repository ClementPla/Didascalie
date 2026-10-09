import { Injectable } from '@angular/core';
import { BboxLabel, SegLabel } from '../../../../core/interface';
import { Rect } from '../interface';
import { ProjectScoped } from '../../../../core/project-scoped';

@Injectable({
  providedIn: 'root'
})
export class BboxManagerService implements ProjectScoped {

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

  /** @see ProjectScoped */
  resetForProject(): void {
    this.clear();
  }
}
