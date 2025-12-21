import { Component, ElementRef, Input, OnInit, ViewChild } from '@angular/core';
import { LabelsService } from '../../../../../../Services/Project/labels.service';
import { BboxLabel, Rect } from '../../../../../../Core/interface';
import { BboxManagerService } from '../../service/bbox-manager.service';
import {  NgClass } from '@angular/common';
import { EditorService } from '../../../services/editor.service';
import { DrawService } from '../../service/draw.service';
import { Tools } from '../../../../../../Core/tools';
import { Point2D } from '../../interface';


@Component({
    selector: 'app-svgelements',
    imports: [NgClass],
    templateUrl: './svgelements.component.html',
    styleUrl: './svgelements.component.scss'
})
export class SVGElementsComponent implements OnInit {
  formattedPoints: string = '';

  @ViewChild('svg') svg: ElementRef<SVGElement>;

  constructor(
    public labelService: LabelsService,
    public editorService: EditorService,
    public bboxManager: BboxManagerService,
    public drawService: DrawService
  ) {}
  ngOnInit(): void {
    this.drawService.previewPoints$.subscribe((points)=>
    {
      this.formattedPoints = this.formatPointsForSvg(points);

    })
  }
  setViewBox(viewbox: Rect) {
    this.svg.nativeElement.setAttribute(
      'viewBox',
      `${viewbox.x} ${viewbox.y} ${viewbox.width} ${viewbox.height}`
    );
  }

  getBboxOpacityAsString(): string {
    let opacity = Math.floor(this.editorService.bbxOpacity * 255);
    // Convert to hex the value between 0 and 255
    let hex = opacity.toString(16);
    if (hex.length < 2) {
      hex = '0' + hex;
    }
    return hex;
  }

  boundingBoxClick(event: MouseEvent, bbox: BboxLabel) {
    if (this.isBboxClickable() && event.button === 0) {
      this.drawService.eraseOnBboxClick(bbox);
    }

  }

  isBboxClickable(): boolean {
    return this.editorService.isEraser() && this.editorService.eraseOnClick;
  }
  isLassoTool(): boolean {
    return this.editorService.selectedTool === Tools.LASSO || this.editorService.selectedTool === Tools.LASSO_ERASER;
  }

  isLineTool(): boolean {
    return this.editorService.selectedTool === Tools.LINE;
  }
  getPolygonStyle(){
    switch(this.editorService.selectedTool){
      case Tools.LASSO_ERASER:
      case Tools.LASSO:
        return {'stroke-width': '2', 'stroke-dasharray': '10'};
      case Tools.LINE:
        return {'stroke-width': this.editorService.lineWidth, 'stroke-linecap': 'round' };
    }
    return {'stroke-width': '1'};
  }
   private formatPointsForSvg(points: Point2D[]): string {
    if (points.length < 2) return '';
    return points.map((p) => `${p.x},${p.y}`).join(' ');
  }
}
  