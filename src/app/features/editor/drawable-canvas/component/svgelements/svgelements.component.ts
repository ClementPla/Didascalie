import { Component, ElementRef, OnDestroy, OnInit, inject, viewChild } from '@angular/core';
import { NgClass } from '@angular/common';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { LabelsService } from '../../../../../services/labels/labels.service';
import { BboxLabel, Rect } from '../../../../../core/interface';
import { BboxManagerService } from '../../service/bbox-manager.service';
import { EditorService } from '../../../services/editor.service';
import { DrawService } from '../../service/draw.service';
import {
  VectorBoundingBox,
  VectorEditorService,
} from '../../service/vector-editor.service';
import { Tools } from '../../../../../core/tools';
import { Point2D } from '../../interface';

@Component({
  selector: 'app-svgelements',
  imports: [NgClass],
  templateUrl: './svgelements.component.html',
  styleUrl: './svgelements.component.scss',
})
export class SVGElementsComponent implements OnInit, OnDestroy {
  labelService = inject(LabelsService);
  editorService = inject(EditorService);
  bboxManager = inject(BboxManagerService);
  drawService = inject(DrawService);
  vectorEditor = inject(VectorEditorService);

  formattedPoints = '';
  readonly svg = viewChild<ElementRef<SVGSVGElement>>('svg');

  private destroy$ = new Subject<void>();

  ngOnInit(): void {
    this.drawService.previewPoints$
      .pipe(takeUntil(this.destroy$))
      .subscribe(points => {
        this.formattedPoints = this.formatPointsForSvg(points);
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /** Set the SVG viewBox, in image coordinates. */
  setViewBox(viewbox: Rect) {
    const svg = this.svg();
    if (!svg) return;
    const w = Math.max(1, viewbox.width);
    const h = Math.max(1, viewbox.height);
    svg.nativeElement.setAttribute(
      'viewBox',
      `${viewbox.x} ${viewbox.y} ${w} ${h}`
    );
  }

  getBboxOpacityAsString(): string {
    const opacity = Math.floor(this.editorService.bbxOpacity * 255);
    return opacity.toString(16).padStart(2, '0');
  }

  boundingBoxClick(event: MouseEvent, bbox: BboxLabel) {
    if (this.isBboxClickable() && event.button === 0) {
      this.drawService.eraseOnBboxClick(bbox);
    }
  }

  isBboxClickable(): boolean {
    return this.editorService.isEraser() && this.editorService.eraseOnClick;
  }

  // ── Vector-shape bounding boxes ─────────────────────────────────────────────

  /** Erase-on-click on a vector shape's bbox deletes the shape (undoable). */
  vectorBboxClick(event: MouseEvent, box: VectorBoundingBox) {
    if (this.isBboxClickable() && event.button === 0) {
      event.stopPropagation();
      this.vectorEditor.deleteShapeById(box.shapeId);
    }
  }

  vectorLabelColor(labelId: number): string {
    return (
      this.labelService.listSegmentationLabels.find((l) => l.id === labelId)
        ?.color ?? '#ffffff'
    );
  }

  isVectorLabelVisible(labelId: number): boolean {
    return (
      this.labelService.listSegmentationLabels.find((l) => l.id === labelId)
        ?.isVisible ?? true
    );
  }

  isLassoTool(): boolean {
    return (
      this.editorService.selectedTool === Tools.LASSO ||
      this.editorService.selectedTool === Tools.LASSO_ERASER
    );
  }

  isLineTool(): boolean {
    return this.editorService.selectedTool === Tools.LINE;
  }

  getPolygonStyle() {
    switch (this.editorService.selectedTool) {
      case Tools.LASSO_ERASER:
      case Tools.LASSO:
        // In image px: the viewBox is in image space.
        return { 'stroke-width': '2', 'stroke-dasharray': '10' };
      case Tools.LINE:
        return {
          'stroke-width': this.editorService.lineWidth,
          'stroke-linecap': 'round',
        };
    }
    return { 'stroke-width': '1' };
  }

  private formatPointsForSvg(points: Point2D[]): string {
    if (points.length < 2) return '';
    return points.map(p => `${p.x},${p.y}`).join(' ');
  }
}