import { Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { NgClass } from '@angular/common';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { LabelsService } from '../../../../../../Services/Labels/labels.service';
import { BboxLabel, Rect } from '../../../../../../Core/interface';
import { BboxManagerService } from '../../service/bbox-manager.service';
import { EditorService } from '../../../services/editor.service';
import { DrawService } from '../../service/draw.service';
import {
  VectorBoundingBox,
  VectorEditorService,
} from '../../service/vector-editor.service';
import { Tools } from '../../../../../../Core/tools';
import { Point2D } from '../../interface';

@Component({
  selector: 'app-svgelements',
  imports: [NgClass],
  templateUrl: './svgelements.component.html',
  styleUrl: './svgelements.component.scss',
})
export class SVGElementsComponent implements OnInit, OnDestroy {
  formattedPoints = '';
  /**
   * Stroke width for line/lasso previews, expressed in *image* px since
   * the SVG viewBox is in image space. Computed from `editorService.lineWidth`
   * and (for visual-only strokes) inverse view scale, but we just use raw
   * image-px values here — viewBox scaling handles the rest.
   */
  @ViewChild('svg') svg: ElementRef<SVGSVGElement>;

  private destroy$ = new Subject<void>();

  constructor(
    public labelService: LabelsService,
    public editorService: EditorService,
    public bboxManager: BboxManagerService,
    public drawService: DrawService,
    public vectorEditor: VectorEditorService,
  ) {}

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

  /**
   * Set the SVG viewBox in image-space coordinates. Called by the parent
   * component on every redraw. The SVG element itself fills the viewport
   * via CSS; the viewBox controls how image-space contents map to viewport px.
   */
  setViewBox(viewbox: Rect) {
    if (!this.svg) return;
    const w = Math.max(1, viewbox.width);
    const h = Math.max(1, viewbox.height);
    this.svg.nativeElement.setAttribute(
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
        // Stroke widths are in image px because the SVG viewBox is image-space.
        // A "2px-looking" outline at zoom 1 is 2 image px; it scales with zoom
        // as the image does. Keep small for thin outlines.
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