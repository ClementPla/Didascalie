import { Injectable } from '@angular/core';
import { Point2D } from '../models';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { OpenCVService } from '../../../../Services/open-cv.service';
import { ProjectService } from '../../../../Services/Project/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { Tools } from '../../../../Core/canvases/tools';
import { EditorService } from '../../../../Services/UI/editor.service';
import { invoke } from '@tauri-apps/api/core';
import { StateManagerService } from './state-manager.service';
import { Subject } from 'rxjs';
import { CanvasManagerService } from './canvas-manager.service';
import { ImageProcessingService } from './image-processing.service';
import { UndoRedoService } from './undo-redo.service';

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
    private imageProcessingService: ImageProcessingService,
    private undoRedoService: UndoRedoService
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

  public applyLasso(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ) {
    if (this.lassoPoints.length < 3) {
      return;
    }
    ctx.strokeStyle = this.getFillColor();
    ctx.fillStyle = this.getFillColor();
    ctx.lineWidth = 0;
    if (this.editorService.swapMarkers) {
      this.swapLasso(ctx);
    } else {
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

      // this.binarizeCanvas(ctx, this.getFillColor());
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
    let bbox = this.stateService.getBoundingBox();
    if (!this.projectService.isInstanceSegmentation) {
      this.openCVService.binarizeCanvas(ctx, color, bbox);
    }
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
    let ctx = this.canvasManagerService.bufferCtx;
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
    switch (this.editorService.selectedTool) {
      case Tools.PEN:
        this.drawPen(ctx, event);
        break;
      case Tools.ERASER:
        this.eraserPen(ctx, event);
        break;
      case Tools.LASSO:
        this.updateLasso(event);
        break;
      case Tools.LASSO_ERASER:
        this.updateLasso(event);
        break;
    }
  }

  public drawPen(ctx: OffscreenCanvasRenderingContext2D, event: MouseEvent) {
    const imageCoord = this.zoomPanService.getImageCoordinates(event);
    // Initialize previous point if not set
    if (this.stateService.isFirstStroke()) {
      this.stateService.updatePreviousPoint(imageCoord);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = false;

    // drawLine(ctx, this.previousPoint, imageCoord, this.editorService.lineWidth, this.getFillColor());
    ctx.beginPath();
    ctx.moveTo(
      this.stateService.previousPoint.x,
      this.stateService.previousPoint.y
    );
    ctx.lineTo(imageCoord.x, imageCoord.y);
    ctx.stroke();

    // Do we need to binarize the canvas here?
    this.binarizeCanvas(ctx, this.getFillColor());

    // Update previous point
    this.stateService.previousPoint = imageCoord;
    this.finalizeDraw(ctx);
  }

  public async endDraw() {
    if (!this.stateService.isDrawing) {
      return;
    }
    let bufferCtx = this.canvasManagerService.bufferCtx;
    let activeCtx = this.canvasManagerService.getActiveCtx();
    this.binarizeCanvas(bufferCtx, this.getFillColor());
    switch (this.editorService.selectedTool) {
      case Tools.PEN:
        let bbox = this.stateService.getBoundingBox();
        if (!this.editorService.autoPostProcess) {
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
        break;
      case Tools.ERASER:
        break;
      case Tools.LASSO:
        if (this.editorService.autoPostProcess) {
          this.applyLasso(bufferCtx);
        } else {
          this.applyLasso(activeCtx);
        }
        break;
      case Tools.LASSO_ERASER:
        if (this.editorService.eraseAll) {
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

    let postProcessCallback;
    if (!this.editorService.autoPostProcess) {
      // Callback is simply Identity
      postProcessCallback = Promise.resolve();
    } else if (this.editorService.isEraser()) {
      postProcessCallback = this.postProcessErase();
    } else if (this.editorService.isDrawingTool()) {
      postProcessCallback = this.postProcessDraw();
    }

    await postProcessCallback?.then(() => {
      console.log('Requesting redraw');
      this.redrawRequest.next(true);
    });

    if (this.projectService.isInstanceSegmentation) {
      if (this.editorService.incrementAfterStroke) {
        this.labelService.incrementActiveInstance();
      }
    }
  }

  public eraserPen(ctx: OffscreenCanvasRenderingContext2D, event: MouseEvent) {
    // Is auto post-processing enabled? In which case, ctx is a buffer canvas
    // and we need to draw on the buffer canvas instead of the active canvas
    // Otherwise, we draw on the active canvas or all class canvases if eraseAll is enabled

    const imageCoord = this.zoomPanService.getImageCoordinates(event);

    // Initialize previous point if not set
    this.stateService.updatePreviousPoint(imageCoord);

    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    ctx.moveTo(
      this.stateService.previousPoint.x,
      this.stateService.previousPoint.y
    );
    ctx.lineTo(imageCoord.x, imageCoord.y);
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
    } else {
      ctx.fillStyle = 'white';
      ctx.strokeStyle = 'black';
      ctx.globalCompositeOperation = 'source-over';
    }

    // Update previous point
    this.stateService.previousPoint = imageCoord;

    if (this.editorService.autoPostProcess) {
      let ctxCombined = this.canvasManagerService.getCombinedCtx();
      ctxCombined.globalAlpha = 0.02;
      ctxCombined.drawImage(ctx.canvas, 0, 0);
      ctxCombined.globalAlpha = 1;
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

  public async postProcessDraw() {
    let bufferCtx = this.canvasManagerService.getBufferCtx();
    let rect = {
      x: 0,
      y: 0,
      width: this.stateService.width,
      height: this.stateService.height,
    };

    if (this.editorService.postProcessOption == 'otsu') {
      rect = this.stateService.getBoundingBox();
    }

    const imageData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    );
    const tmp = new OffscreenCanvas(rect.width, rect.height);
    const tmpImage = new OffscreenCanvas(rect.width, rect.height);
    tmp.getContext('2d')?.putImageData(imageData!, 0, 0);

    tmpImage
      .getContext('2d')
      ?.drawImage(
        this.imageProcessingService.getCurrentCanvas(),
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        0,
        0,
        rect.width,
        rect.height
      );

    let blobMask$ = tmp.convertToBlob({ type: 'image/png' });
    let blobImage$ = tmpImage.convertToBlob({ type: 'image/png' });

    await Promise.all([blobMask$, blobImage$])
      .then(async (values) => {
        if (values[0] && values[1]) {
          switch (this.editorService.postProcessOption) {
            case 'otsu':
              return invoke<Uint8ClampedArray>('refine_segmentation', {
                mask: await values[0]!.arrayBuffer(),
                image: await values[1]!.arrayBuffer(),
                opening: this.editorService.autoPostProcessOpening,
                inverse: this.editorService.useInverse,
                kernelSize: this.editorService.morphoSize,
                connectedness: this.editorService.enforceConnectivity,
              });
            case 'MedSAM':
              return invoke<Uint8ClampedArray>('sam_segment', {
                coarseMask: await values[0]!.arrayBuffer(),
                image: await values[1]!.arrayBuffer(),
                threshold: this.editorService.samThreshold
              });
          }
        }
        return null;
      })
      .then(async (result: Uint8ClampedArray | null) => {
        if (!result) {
          return;
        }
        // Decode PNG blob to Uint8ClampedArray
        let blob = new Blob([result], { type: 'image/png' });
        let imageBitmap = await createImageBitmap(blob);
        let activeCtx = this.canvasManagerService.getActiveCtx();
        let bufferCanvas = this.canvasManagerService.getBufferCanvas();
        if (this.editorService.postProcessOption == 'MedSAM') {
          bufferCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
          bufferCtx.drawImage(imageBitmap, rect.x, rect.y);
          activeCtx.drawImage(bufferCanvas, 0, 0);
          this.binarizeCanvas(activeCtx, this.getFillColor());
        } else {
          bufferCtx.globalCompositeOperation = 'destination-over';
          bufferCtx.clearRect(rect.x, rect.y, rect.width, rect.height);
          bufferCtx.drawImage(imageBitmap, rect.x, rect.y);
          activeCtx.drawImage(bufferCanvas, 0, 0);
          this.binarizeCanvas(activeCtx, this.getFillColor());
        }
        this.stateService.recomputeCanvasSum = true;
      });
  }

  public async postProcessErase() {
    let bufferCtx = this.canvasManagerService.getBufferCtx();

    const blobBuffer = await bufferCtx.canvas.convertToBlob({
      type: 'image/png',
    });

    let allPromises: Promise<void>[] = [];
    this.canvasManagerService.getAllCanvas().forEach((classCanvas, index) => {
      if (
        index != this.labelService.getActiveIndex() &&
        !this.editorService.eraseAll
      ) {
        return;
      }
      const blobClass$ = classCanvas
        .convertToBlob({ type: 'image/png' })
        .then(async (blob) => {
          return invoke<Uint8ClampedArray>('find_overlapping_region', {
            label: await blob.arrayBuffer(),
            mask: await blobBuffer.arrayBuffer(),
          });
        })
        .then(async (result: Uint8ClampedArray | null) => {
          if (!result) {
            return;
          }
          let blob = new Blob([result], { type: 'image/png' });
          let imageBitmap = await createImageBitmap(blob);
          if (imageBitmap) {
            const ctx = classCanvas.getContext('2d', { alpha: true })!;
            ctx.globalCompositeOperation = 'destination-out';
            ctx.drawImage(imageBitmap, 0, 0);
          }
        });
      allPromises.push(blobClass$);
    });

    Promise.all(allPromises).then(() => {
      this.stateService.recomputeCanvasSum = true;
      this.redrawRequest.next(true);
    });
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

  public swapLasso(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ) {
    // Create buffer canvas only once
    this.clearCanvas(this.canvasManagerService.bufferCtx);
    const ctxBuffer = this.canvasManagerService.bufferCtx;
    // Batch draw other class canvases
    const activeIndex = this.labelService.getActiveIndex();

    ctxBuffer.drawImage(this.canvasManagerService.getCombinedCanvas(), 0, 0);

    // Create lasso path mask
    ctxBuffer.globalCompositeOperation = 'source-in';
    ctxBuffer.fillStyle = this.getFillColor();
    ctxBuffer.beginPath();

    const lassoPath = this.lassoPoints.map((point) =>
      this.zoomPanService.fromCanvasToImageCoordinates(point)
    );

    ctxBuffer.moveTo(lassoPath[0].x, lassoPath[0].y);
    lassoPath.slice(1).forEach((coord) => {
      ctxBuffer.lineTo(coord.x, coord.y);
    });

    ctxBuffer.closePath();
    ctxBuffer.fill();
    this.binarizeCanvas(ctxBuffer, this.getFillColor());

    // Draw masked buffer to main context
    ctx.drawImage(this.canvasManagerService.getBufferCanvas(), 0, 0);

    // Remove masked area from other class canvases
    this.canvasManagerService.getAllCanvas().forEach((classCanvas, index) => {
      if (index === activeIndex) return;
      const ctxClass = classCanvas.getContext('2d', { alpha: true })!;
      ctxClass.globalCompositeOperation = 'destination-out';
      ctxClass.drawImage(this.canvasManagerService.getBufferCanvas(), 0, 0);
      ctxClass.globalCompositeOperation = 'source-over';
    });
    // Reset composite operations
    ctx.globalCompositeOperation = 'source-over';
    ctxBuffer.globalCompositeOperation = 'source-over';
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
