import { Component, ElementRef, Input, ViewChild } from '@angular/core';
import { LabelsService } from '../../../../../../Services/Project/labels.service';
import { BboxLabel, Point2D, Rect } from '../../../../../../Core/interface';
import { BboxManagerService } from '../../service/bbox-manager.service';
import { NgFor, NgClass } from '@angular/common';
import { SVGUIService } from '../../service/svgui.service';
import { EditorService } from '../../../../../../Services/UI/editor.service';
import { DrawService } from '../../service/draw.service';

@Component({
  selector: 'app-svgelements',
  standalone: true,
  imports: [NgFor, NgClass],
  templateUrl: './svgelements.component.html',
  styleUrl: './svgelements.component.scss',
})
export class SVGElementsComponent {
  @Input() UIPoints: string = '';

  @ViewChild('svg') svg: ElementRef<SVGElement>;

  constructor(
    public labelService: LabelsService,
    public editorService: EditorService,
    public bboxManager: BboxManagerService,
    public svgUIService: SVGUIService,
    private drawService: DrawService
  ) {}

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

  boundingBoxClick(bbox: BboxLabel) {
    if (this.isBboxClickable()) {
      this.drawService.eraseOnBboxClick(bbox);
    }

  }

  isBboxClickable(): boolean {
    return this.editorService.isEraser() && this.editorService.eraseOnClick;
  }
}
