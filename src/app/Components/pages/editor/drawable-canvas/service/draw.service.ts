import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { ProjectService } from '../../../../../Services/ProjectService/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { StateManagerService } from './state-manager.service';
import { CanvasManagerService } from './canvas-manager.service';
import { UndoRedoService } from './undo-redo.service';
import { PostProcessService } from './post-process.service';

import { Tools } from '../../../../../Core/tools';
import { BboxLabel } from '../../../../../Core/interface';
import {
  swapUnderStroke,
  clearComponentAt,
  intRect,
} from '../../../../../Core/misc/label-ops';
import { Point2D, DrawingTool, ToolContext } from '../interface';
import { PenTool, EraserTool, LassoTool, LineTool, LassoEraserTool } from '../tools';
import { IOService } from '../../../../../Services/io.service';

@Injectable({ providedIn: 'root' })
export class DrawService implements OnDestroy {
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

  constructor(
    private labelService: LabelsService,
    private projectService: ProjectService,
    private zoomPanService: ZoomPanService,
    private editorService: EditorService,
    private stateService: StateManagerService,
    private canvasManagerService: CanvasManagerService,
    private undoRedoService: UndoRedoService,
    private postProcessService: PostProcessService,
    private ioService: IOService
  ) {
    this.initializeSubscriptions();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ==========================================
  // Core lifecycle
  // ==========================================

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

  // ==========================================
  // Context helper
  // ==========================================

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

  // ==========================================
  // Shared actions
  // ==========================================

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
    if (this.projectService.isInstanceSegmentation()) {
      const v = this.labelService.activeSegInstance?.instance ?? 1;
      return Math.min(255, Math.max(1, Math.round(v)));
    }
    return 1;
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

  // ==========================================
  // Subscriptions
  // ==========================================

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
      .subscribe((value) => {
        if (value >= 0) {
          this.canvasManagerService.clearMaskAtIndex(value);
          this.stateService.recomputeCanvasSum = true;
          this.ioService.markLabelDirty(value);
          this.redrawRequest.next(true);
        }
      });
  }

  // ==========================================
  // Bbox actions
  // ==========================================

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
