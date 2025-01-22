import { Injectable } from '@angular/core';
import { Point2D } from '../models';
import { LabelsService } from '../../../../../Services/Project/labels.service';
import { OpenCVService } from '../../../../../Services/open-cv.service';
import { ProjectService } from '../../../../../Services/Project/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { Tools } from '../../../../../Core/tools';
import { EditorService } from '../../../../../Services/UI/editor.service';
import { StateManagerService } from './state-manager.service';
import { Subject } from 'rxjs';
import { CanvasManagerService } from './canvas-manager.service';
import { UndoRedoService } from './undo-redo.service';
import { PostProcessService } from './post-process.service';
import { SVGUIService } from './svgui.service';
import { PostProcessOption } from '../../../../../Core/tools';

@Injectable({
  providedIn: 'root',
})
export class DrawService {
  public lassoPoints: Point2D[] = [];
  public redrawRequest = new Subject<boolean>();
  public singleDrawRequest =
    new Subject<OffscreenCanvasRenderingContext2D | null>();

  constructor(
    private labelService: LabelsService,
    private openCVService: OpenCVService,
    private projectService: ProjectService,
    private zoomPanService: ZoomPanService,
    private editorService: EditorService,
    private stateService: StateManagerService,
    private canvasManagerService: CanvasManagerService,
    private undoRedoService: UndoRedoService,
    private postProcessService: PostProcessService,
    private svgUIService: SVGUIService
  ) {
    this.editorService.canvasSumRefresh.subscribe((value) => {
      this.canvasManagerService.computeCombinedCanvas();
      this.redrawRequest.next(true);
    });

    this.editorService.canvasRedraw.subscribe((value) => {
      if (value) {
        this.stateService.recomputeCanvasSum = value;
        this.refreshColor();
      }
    });

    this.editorService.canvasClear.subscribe((value) => {
      if (value >= 0) {
        this.stateService.recomputeCanvasSum = true;
        this.canvasManagerService.clearCanvasAtIndex(value);
        this.redrawRequest.next(true);
      }
    });
  }

  public applyLasso() {
    if (this.lassoPoints.length < 3) {
      return;
    }
    let ctx = this.canvasManagerService.getBufferCtx();
    ctx.strokeStyle = this.getFillColor();
    ctx.fillStyle = this.getFillColor();
    ctx.lineWidth = 0;
    ctx.globalCompositeOperation = 'source-over';
    let prev: Point2D = this.lassoPoints[0];
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    for (let i = 1; i < this.lassoPoints.length; i++) {
      const canvasCoord = this.lassoPoints[i];
      ctx.lineTo(canvasCoord.x, canvasCoord.y);
    }
    ctx.closePath();
    for (let i = 0; i < 20; i++) {
      ctx.fill();
    }

    if (this.editorService.swapMarkers) {
      this.swapMarkers();
    }

    if (!this.editorService.autoPostProcess) {
      let bbox = this.stateService.getBoundingBox();
      this.canvasManagerService
        .getActiveCtx()
        .drawImage(
          ctx.canvas,
          bbox.x,
          bbox.y,
          bbox.width,
          bbox.height,
          bbox.x,
          bbox.y,
          bbox.width,
          bbox.height
        );
    }

    this.lassoPoints = [];
    ctx.globalCompositeOperation = 'source-over';
  }

  public applyLassoEraser(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ) {
    if (this.lassoPoints.length < 3) {
      return;
    }
    ctx.strokeStyle = this.getFillColor();
    ctx.fillStyle = this.getFillColor();
    ctx.lineWidth = 0;
    ctx.globalCompositeOperation = 'destination-out';
    let prev: Point2D = this.lassoPoints[0];
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y);
    for (let i = 1; i < this.lassoPoints.length; i++) {
      const canvasCoord = this.lassoPoints[i];
      ctx.lineTo(canvasCoord.x, canvasCoord.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  public binarizeCanvas(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    color: string
  ) {
    // let bbox = this.stateService.getBoundingBox();
    // if (!this.projectService.isInstanceSegmentation) {
    //   this.openCVService.binarizeCanvas(ctx, color, bbox);
    // }
  }

  public clearCanvas(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ) {
    ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  public draw(event: MouseEvent) {
    if (!this.stateService.isDrawing) {
      return;
    }
    if (!this.labelService.activeLabel) {
      return;
    }
    let ctx = this.canvasManagerService.getBufferCtx();
    if (!ctx) {
      return;
    }
    this.stateService.recomputeCanvasSum = true;
    const imageCoord = this.zoomPanService.getImageCoordinates(event);
    const x = imageCoord.x;
    const y = imageCoord.y;

    this.stateService.updateMinMaxPoints({ x, y });

    ctx.fillStyle = this.getFillColor();
    ctx.strokeStyle = this.getFillColor();
    ctx.lineWidth = this.editorService.lineWidth;
    // Deactivate anti-aliasing
    ctx.imageSmoothingEnabled = false;
    ctx.lineCap = 'round';
    if (this.stateService.isFirstStroke()) {
      this.stateService.updatePreviousPoint(imageCoord);
    }
    this.stateService.updateCurrentPoint(imageCoord);
    switch (this.editorService.selectedTool) {
      case Tools.PEN:
        this.drawPen(ctx);
        break;
      case Tools.ERASER:
        this.eraserPen(ctx);
        break;
      case Tools.LASSO:
        this.updateLasso(event);
        break;
      case Tools.LASSO_ERASER:
        this.updateLasso(event);
        break;
    }
    this.stateService.updatePreviousPoint(imageCoord);
  }

  public drawPen(ctx: OffscreenCanvasRenderingContext2D) {
    // Initialize previous point if not set

    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;

    ctx.beginPath();
    ctx.moveTo(
      this.stateService.previousPoint.x,
      this.stateService.previousPoint.y
    );
    ctx.lineTo(
      this.stateService.currentPoint.x,
      this.stateService.currentPoint.y
    );
    ctx.stroke();

    // this.binarizeCanvas(ctx, this.getFillColor());

    // Update previous point
    this.finalizeDraw(ctx);
  }

  public async endDraw() {
    if (!this.stateService.isDrawing) {
      return;
    }
    this.stateService.recomputeCanvasSum = true;
    let bufferCtx = this.canvasManagerService.bufferCtx;
    let activeCtx = this.canvasManagerService.getActiveCtx();
    this.binarizeCanvas(bufferCtx, this.getFillColor());
    this.stateService.recomputeCanvasSum = true;
    switch (this.editorService.selectedTool) {
      case Tools.PEN:
        let bbox = this.stateService.getBoundingBox();
        if (!this.editorService.autoPostProcess) {
          if (this.editorService.swapMarkers) {
            this.swapMarkers();
          } else {
            activeCtx.drawImage(
              this.canvasManagerService.getBufferCanvas(),
              bbox.x,
              bbox.y,
              bbox.width,
              bbox.height,
              bbox.x,
              bbox.y,
              bbox.width,
              bbox.height
            );
          }
        }
        break;
      case Tools.ERASER:
        break;
      case Tools.LASSO:
        this.applyLasso();
        break;
      case Tools.LASSO_ERASER:
        if(this.editorService.autoPostProcess){
          this.applyLasso();
        }
        else if (this.editorService.eraseAll) {
          this.canvasManagerService.getAllCanvasCtx().forEach((ctx) => {
            this.applyLassoEraser(ctx);
          });
        } else {
          this.applyLassoEraser(activeCtx);
        }
        this.lassoPoints = [];
        break;
    }
    this.stateService.isDrawing = false;

    let postProcessCallback = new Promise<void>((resolve) => {
      resolve();
    });
    if (this.editorService.autoPostProcess) {
      if (this.editorService.isEraser()) {
        postProcessCallback = this.postProcessErase();
      } else if (this.editorService.isDrawingTool()) {
        postProcessCallback = this.postProcessDraw();
      }
    }
    await postProcessCallback?.then(() => {
      this.redrawRequest.next(true);
    });

    if (this.projectService.isInstanceSegmentation) {
      if (this.editorService.incrementAfterStroke) {
        this.labelService.incrementActiveInstance();
      }
    }
  }

  public eraserPen(ctx: OffscreenCanvasRenderingContext2D) {
    // Is auto post-processing enabled? In which case, ctx is a buffer canvas
    // and we need to draw on the buffer canvas instead of the active canvas
    // Otherwise, we draw on the active canvas or all class canvases if eraseAll is enabled

    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.moveTo(
      this.stateService.previousPoint.x,
      this.stateService.previousPoint.y
    );
    ctx.lineTo(
      this.stateService.currentPoint.x,
      this.stateService.currentPoint.y
    );
    ctx.stroke();

    this.binarizeCanvas(ctx, this.getFillColor());
    let bbox = this.stateService.getBoundingBox();

    if (!this.editorService.autoPostProcess) {
      this.canvasManagerService.getAllCanvasCtx().forEach((ctxClass, index) => {
        if (
          index != this.labelService.getActiveIndex() &&
          !this.editorService.eraseAll
        ) {
          return;
        }
        ctxClass.globalCompositeOperation = 'destination-out';
        ctxClass.drawImage(
          ctx.canvas,
          bbox.x,
          bbox.y,
          bbox.width,
          bbox.height,
          bbox.x,
          bbox.y,
          bbox.width,
          bbox.height
        );
        ctxClass.globalCompositeOperation = 'source-over';
      });
    }
    else {
      this.svgUIService.addPoint(this.stateService.currentPoint);
    }

    this.redrawRequest.next(true);
  }

  public finalizeDraw(ctx: OffscreenCanvasRenderingContext2D) {
    this.singleDrawRequest.next(ctx);
  }

  public getFillColor() {
    if (this.projectService.isInstanceSegmentation) {
      if (!this.labelService.activeSegInstance) {
        throw new Error('No active instance');
      }
      return this.labelService.activeSegInstance.shade;
    }

    const color = this.labelService.activeLabel?.color;
    return color ? color : '#ffffff';
  }

  public postProcessDraw() {
    this.stateService.recomputeCanvasSum = true;
    switch (this.editorService.postProcessOption) {
      case PostProcessOption.OTSU:
        return this.postProcessService.otsu_post_process();
      case PostProcessOption.MEDSAM:
        return this.postProcessService.sam_post_process();
      case PostProcessOption.CRF:
        return this.postProcessService.crf_post_process();
    }
    return new Promise<void>((resolve) => {
      resolve();
    });
  }

  public async postProcessErase() {
    await this.postProcessService.eraseAll_post_process();
  }

  public refreshColor(
    inputCtx: OffscreenCanvasRenderingContext2D | null = null,
    inputColor: string | null = null
  ) {
    if (this.projectService.isInstanceSegmentation) {
      this.redrawRequest.next(true);
      return;
    }

    let ctx:
      | OffscreenCanvasRenderingContext2D
      | CanvasRenderingContext2D
      | null;
    if (!inputCtx) {
      ctx = this.canvasManagerService.getActiveCtx();
    } else {
      ctx = inputCtx;
    }
    if (!ctx) {
      ctx =
        this.canvasManagerService.canvasCtx[
        this.canvasManagerService.canvasCtx.length - 1
        ];
      this.labelService.activeLabel =
        this.labelService.listSegmentationLabels[
        this.labelService.listSegmentationLabels.length - 1
        ];
    }
    if (!ctx) {
      return;
    }
    let color = inputColor ? inputColor : this.labelService.activeLabel?.color;

    ctx.fillStyle = color ? color : '#ffffff';
    ctx.strokeStyle = color ? color : '#ffffff';
    ctx.globalCompositeOperation = 'source-atop';

    ctx.fillRect(0, 0, this.stateService.width, this.stateService.height);
    ctx.globalCompositeOperation = 'source-over';

    this.redrawRequest.next(true);
  }

  public refreshAllColors() {
    this.canvasManagerService.getAllCanvasCtx().forEach((ctx, index) => {
      this.refreshColor(
        ctx,
        this.labelService.listSegmentationLabels[index].color
      );
    });
  }

  public startDraw() {
    this.stateService.reset();
    this.stateService.isDrawing = true;
    this.lassoPoints = [];
    this.clearCanvas(this.canvasManagerService.bufferCtx);
    return this.undoRedoService.update_undo_redo();
  }

  public swapMarkers() {
    const activeIndex = this.labelService.getActiveIndex();
    let ctx = this.canvasManagerService.getBufferCtx();
    let bufferCanvas = this.canvasManagerService.getBufferCanvas();
    ctx.fillStyle = this.getFillColor();
    // We find the shape that overlap the current buffer with the other class canvas
    const rect = this.stateService.getBoundingBox();
    ctx.globalCompositeOperation = 'source-in';
    this.stateService.recomputeCanvasSum = true;
    const edgesOnly = this.editorService.edgesOnly;
    this.editorService.edgesOnly = false;
    this.canvasManagerService.computeCombinedCanvas();
    this.editorService.edgesOnly = edgesOnly;

    ctx.drawImage(
      this.canvasManagerService.getCombinedCanvas(),
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      rect.x,
      rect.y,
      rect.width,
      rect.height
    );


    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.globalCompositeOperation = 'source-over';

    // Now, we remove the overlapped shape from the other class canvas
    this.canvasManagerService.getAllCanvasCtx().forEach((classCtx, index) => {
      if (index === activeIndex) {
        classCtx.globalCompositeOperation = 'source-over';
      } else {
        classCtx.globalCompositeOperation = 'destination-out';
      }
      classCtx.drawImage(
        bufferCanvas,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        rect.x,
        rect.y,
        rect.width,
        rect.height
      );
      classCtx.globalCompositeOperation = 'source-over';
    });
    this.stateService.recomputeCanvasSum = true;
  }

  public updateLasso(event: MouseEvent) {
    const canvasCoord = this.zoomPanService.getImageCoordinates(event);

    this.lassoPoints.push(canvasCoord);
  }

  public wheel(event: WheelEvent) {
    if (event.ctrlKey) {
      this.editorService.lineWidth += event.deltaY > 0 ? -2 : 2;
    } else {
      this.zoomPanService.wheel(event);
    }
  }
}
