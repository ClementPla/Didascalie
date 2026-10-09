import { Injectable, OnDestroy, inject } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { LabelsService } from '../../../../services/labels/labels.service';
import { ProjectService } from '../../../../services/project/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { StateManagerService } from './state-manager.service';
import { CanvasManagerService } from './canvas-manager.service';
import { UndoRedoService } from './undo-redo.service';
import { PostProcessService } from './post-process.service';
import { VectorEditorService } from './vector-editor.service';

import { Tools } from '../../../../core/tools';
import { BboxLabel } from '../../../../core/interface';
import {
  swapUnderStroke,
  clearComponentAt,
  intRect,
} from '../../../../core/misc/label-ops';
import { Point2D, DrawingTool, ToolContext } from '../interface';
import { PenTool, EraserTool, LassoTool, LineTool, LassoEraserTool } from '../tools';
import { IOService } from '../../../../services/io.service';

@Injectable({ providedIn: 'root' })
export class DrawService implements OnDestroy {
  private labelService = inject(LabelsService);
  private projectService = inject(ProjectService);
  private zoomPanService = inject(ZoomPanService);
  private editorService = inject(EditorService);
  private stateService = inject(StateManagerService);
  private canvasManagerService = inject(CanvasManagerService);
  private undoRedoService = inject(UndoRedoService);
  private postProcessService = inject(PostProcessService);
  private ioService = inject(IOService);
  private vectorEditor = inject(VectorEditorService);

  public redrawRequest = new Subject<boolean>();
  public singleDrawRequest = new Subject<OffscreenCanvasRenderingContext2D | null>();
  public previewPoints$ = new BehaviorSubject<Point2D[]>([]);

  private tools = new Map<Tools, DrawingTool>([
    [Tools.PEN, new PenTool()],
    [Tools.ERASER, new EraserTool()],
    [Tools.LINE, new LineTool()],
    [Tools.LASSO, new LassoTool()],
    [Tools.LASSO_ERASER, new LassoEraserTool()],
  ]);

  private currentToolContext: ToolContext | null = null;
  private destroy$ = new Subject<void>();

  constructor() {
    this.initializeSubscriptions();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Core lifecycle ───────────────────────────────────────────────────────

  public startDraw(event: MouseEvent): void {
    this.stateService.reset();
    this.stateService.isDrawing = true;

    const coords = this.zoomPanService.getImageCoordinates(event);
    this.stateService.updateCurrentPoint(coords);
    this.stateService.updatePreviousPoint(coords);

    // Position + clear the stroke buffer window around the stroke start.
    this.canvasManagerService.beginStrokeBuffer(coords);
    this.currentToolContext = this.createToolContext();

    const tool = this.tools.get(this.editorService.selectedTool);
    tool?.start(event, this.currentToolContext);
  }

  public draw(event: MouseEvent): void {
    if (!this.stateService.isDrawing || !this.labelService.activeLabel) return;

    const tool = this.tools.get(this.editorService.selectedTool);
    if (!tool || !this.currentToolContext) return;

    const imageCoord = this.zoomPanService.getImageCoordinates(event);
    this.stateService.updatePreviousPoint(this.stateService.currentPoint);
    this.stateService.updateCurrentPoint(imageCoord);
    // Bound both endpoints of the segment at the current radius (see original
    // note): captures the down position too, which is otherwise never bounded.
    this.stateService.updateMinMaxPoints(imageCoord);
    this.stateService.updateMinMaxPoints(this.stateService.previousPoint);

    if (this.editorService.isEraser()) {
      this.stateService.recomputeCanvasSum = true;
    }

    this.currentToolContext.color = this.getFillColor();
    this.currentToolContext.value = this.getActiveValue();
    tool.draw(event, this.currentToolContext);
  }

  /** Abort an in-progress stroke without committing it (e.g. pinch takeover). */
  public cancelDraw(): void {
    if (!this.stateService.isDrawing) return;
    this.stateService.isDrawing = false;
    this.currentToolContext = null;
    this.canvasManagerService.beginStrokeBuffer();
    this.redrawRequest.next(true);
  }

  public async endDraw(event: MouseEvent): Promise<void> {
    if (!this.stateService.isDrawing) return;

    const imageCoord = this.zoomPanService.getImageCoordinates(event);
    this.stateService.updateCurrentPoint(imageCoord);

    const tool = this.tools.get(this.editorService.selectedTool);
    if (tool && this.currentToolContext) {
      await tool.end(this.currentToolContext);
    }

    this.stateService.isDrawing = false;
    this.currentToolContext = null;

    await this.handleGlobalPostProcessing();
    this.stateService.recomputeCanvasSum = true;

    this.redrawRequest.next(true);
    this.ioService.markDirty();

    if (
      this.projectService.isInstanceSegmentation() &&
      this.editorService.incrementAfterStroke
    ) {
      this.labelService.incrementActiveInstance();
    }

    await this.undoRedoService.updateUndoRedo();
  }

  // ── Context helper ───────────────────────────────────────────────────────

  private createToolContext(): ToolContext {
    return {
      canvasManager: this.canvasManagerService,
      stateService: this.stateService,
      editorService: this.editorService,
      color: this.getFillColor(),
      value: this.getActiveValue(),
      getCoords: (e) => this.zoomPanService.getImageCoordinates(e),
      swapMarkers: () => this.swapMarkers(),
      singleDrawRequest: (ctx) => this.singleDrawRequest.next(ctx),
      redrawRequest: () => this.redrawRequest.next(true),
      updatePreviewPoints: (points: Point2D[]) => this.previewPoints$.next(points),
    };
  }

  // ── Shared actions ───────────────────────────────────────────────────────

  /** Swap the label under the stroke to the active label/instance value. */
  public swapMarkers(): void {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const rect = intRect(this.stateService.getBoundingBox(), w, h);
    if (!rect) return;

    const region = this.canvasManagerService.readBufferRegion(rect);

    swapUnderStroke(
      this.canvasManagerService.getAllMasks(),
      this.canvasManagerService.getActiveIndex(),
      w,
      region,
      rect,
      this.getActiveValue()
    );
    this.stateService.recomputeCanvasSum = true;
  }

  private async handleGlobalPostProcessing(): Promise<void> {
    if (this.editorService.penPostProcess && this.editorService.isDrawingTool()) {
      this.stateService.recomputeCanvasSum = true;
      await this.postProcessService.getPostProcessFunction();
    } else if (this.editorService.eraserPostProcess && this.editorService.isEraser()) {
      await this.postProcessService.eraseConnectedComponents_post_process();
    }
  }

  /** Active display colour, used for the live stroke preview only. */
  public getFillColor(): string {
    if (this.projectService.isInstanceSegmentation()) {
      return this.labelService.activeSegInstance?.shade || this.labelService.activeLabel?.color || '#ffffff';
    }
    return this.labelService.activeLabel?.color ?? '#ffffff';
  }

  /** Active mask value written on commit: instance id, or 1 for semantic. */
  public getActiveValue(): number {
    return this.labelService.paintValue(this.projectService.isInstanceSegmentation());
  }

  public clearCanvas(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ): void {
    ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  /**
   * Re-apply label colours to the displayed composite. Since colour lives only
   * in the palettes now, this rebuilds them and recomposites — no pixel edits.
   */
  public recolor(): void {
    this.canvasManagerService.rebuildPalettes();
    this.stateService.recomputeCanvasSum = true;
    this.redrawRequest.next(true);
  }

  // ── Subscriptions ────────────────────────────────────────────────────────

  private initializeSubscriptions(): void {
    this.editorService.canvasSumRefresh
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.canvasManagerService.computeCombinedCanvas();
        this.redrawRequest.next(true);
      });

    this.editorService.canvasRedraw
      .pipe(takeUntil(this.destroy$))
      .subscribe((value) => {
        if (value) this.recolor();
      });

    this.editorService.canvasClear
      .pipe(takeUntil(this.destroy$))
      // -1 means all labels.
      .subscribe((index) =>
        index >= 0 ? this.clearLabel(index) : this.clearFrame(),
      );
  }

  /**
   * Erase everything annotated under one label: its raster mask *and* its
   * vector paths.
   *
    * A label's annotation is both halves, so both go, in one undo group.
   */
  private clearLabel(index: number): void {
    const labelId = this.labelService.listSegmentationLabels[index]?.id;

    this.undoRedoService.beginGroup();
    this.undoRedoService.snapshotLayers([index]);
    this.canvasManagerService.clearMaskAtIndex(index);
    if (labelId != null) this.vectorEditor.deleteShapesForLabel(labelId);
    this.undoRedoService.endGroup();

    this.finishClear([index]);
  }

  /**
   * Erase every label on this frame, raster and vector, as one undo step.
   *
   * Deliberately one group rather than a loop of `clearLabel`: undoing a
   * "clear frame" should restore the frame, not require one Ctrl+Z per label.
   */
  private clearFrame(): void {
    const indices = this.labelService.listSegmentationLabels.map((_, i) => i);
    if (indices.length === 0) return;

    this.undoRedoService.beginGroup();
    this.undoRedoService.snapshotLayers(indices);
    indices.forEach((i) => this.canvasManagerService.clearMaskAtIndex(i));
    this.vectorEditor.deleteAllShapes();
    this.undoRedoService.endGroup();

    this.finishClear(indices);
  }

  /** Shared tail of a clear: recompute, mark dirty for save, repaint. */
  private finishClear(indices: number[]): void {
    this.stateService.recomputeCanvasSum = true;
    indices.forEach((i) => this.ioService.markLabelDirty(i));
    this.redrawRequest.next(true);
  }

  // ── Bbox actions ─────────────────────────────────────────────────────────

  /** Erase the labelled object(s) under a clicked bounding box. */
  public eraseOnBboxClick(bbox: BboxLabel): void {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const rect = intRect(bbox.bbox, w, h);
    if (!rect) return;

    const isCombined = this.editorService.labelledCombinedBoundingBox;
    const labels = this.labelService.listSegmentationLabels;

    this.canvasManagerService.getAllMasks().forEach((mask, index) => {
      if (!isCombined && labels[index]?.label !== bbox.label.label) return;

      for (let ry = 0; ry < rect.height; ry++) {
        for (let rx = 0; rx < rect.width; rx++) {
          const x = rect.x + rx;
          const y = rect.y + ry;
          if (mask[y * w + x] !== 0) clearComponentAt(mask, w, h, x, y);
        }
      }
    });

    this.stateService.recomputeCanvasSum = true;
    this.ioService.markDirty();
    this.redrawRequest.next(true);
  }
}
