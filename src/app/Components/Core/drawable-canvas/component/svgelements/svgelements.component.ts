import { Component, ElementRef, Input, ViewChild } from '@angular/core';
import { LabelsService } from '../../../../../Services/Project/labels.service';
import { Point2D, Rect } from '../../../../../Core/interface';
import { BboxManagerService } from '../../service/bbox-manager.service';
import { NgFor } from '@angular/common';
import { SVGUIService } from '../../service/svgui.service';
import { EditorService } from '../../../../../Services/UI/editor.service';


@Component({
  selector: 'app-svgelements',
  standalone: true,
  imports: [NgFor],
  templateUrl: './svgelements.component.html',
  styleUrl: './svgelements.component.scss',
})
export class SVGElementsComponent {
  @Input() UIPoints: string = '';

  @ViewChild('svg') svg: ElementRef<SVGElement>;

  constructor(public labelService: LabelsService, 
    public editorService: EditorService,
    public bboxManager: BboxManagerService, 
    public svgUIService: SVGUIService) {}

  setViewBox(viewbox: Rect) {
    this.svg.nativeElement.setAttribute(
      'viewBox',
      `${viewbox.x} ${viewbox.y} ${viewbox.width} ${viewbox.height}`
    );
  }
}
