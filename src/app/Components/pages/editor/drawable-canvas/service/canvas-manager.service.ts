import { Injectable } from '@angular/core';
import { StateManagerService } from './state-manager.service';
import { LabelsService } from '../../../../../Services/Project/labels.service';
import { OpenCVService } from '../../../../../Services/open-cv.service';
import { EditorService } from '../../../../../Services/UI/editor.service';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class CanvasManagerService {
  labelCanvas: OffscreenCanvas[] = [];
  canvasCtx: OffscreenCanvasRenderingContext2D[] = [];

  combinedCanvas: OffscreenCanvas;
  combinedCtx: OffscreenCanvasRenderingContext2D;

  bufferCanvas: OffscreenCanvas;
  bufferCtx: OffscreenCanvasRenderingContext2D;

  requestRedraw: Subject<boolean> = new Subject<boolean>();

  constructor(
    private stateService: StateManagerService,
    private labelService: LabelsService,
    private openCVService: OpenCVService,
    private editorService: EditorService
  ) {}

  initCanvas() {
    this.labelCanvas = [];
    this.canvasCtx = [];
    this.labelService.listSegmentationLabels.forEach((label) => {
      const canvas = new OffscreenCanvas(
        this.stateService.width,
        this.stateService.height
      );
      this.labelCanvas.push(canvas);
      this.canvasCtx.push(
        canvas.getContext('2d', { alpha: true })!
      );
    });
    this.combinedCanvas = new OffscreenCanvas(
      this.stateService.width,
      this.stateService.height
    );
    this.combinedCtx = this.combinedCanvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    })!;
    this.bufferCanvas = new OffscreenCanvas(
      this.stateService.width,
      this.stateService.height
    );
    this.bufferCtx = this.bufferCanvas.getContext('2d', {
      alpha: true,
      desynchronized: true,
    })!;
  }

  computeCombinedCanvas() {
    this.combinedCtx.clearRect(
      0,
      0,
      this.stateService.width,
      this.stateService.height
    );
    if (this.combinedCanvas instanceof HTMLCanvasElement) {
      this.combinedCanvas.style.imageRendering = 'pixelated';
    }
    this.ensurePixelPerfectDrawing(this.combinedCtx);

    this.labelCanvas.forEach((canvas, index) => {
      if (!this.labelService.listSegmentationLabels[index].isVisible) {
        return;
      }

    this.drawCanvasToCanvas(this.canvasCtx[index], this.combinedCtx);

    });
    if (this.editorService.edgesOnly) {
      let edge = this.openCVService.edgeDetection_v2(this.combinedCtx);
      this.combinedCtx.clearRect(
        0,
        0,
        this.stateService.width,
        this.stateService.height
      );
      const edgeCtx = edge.getContext('2d') as OffscreenCanvasRenderingContext2D;

      this.drawCanvasToCanvas(edgeCtx, this.combinedCtx);
    }
  }
  public drawCanvasToCanvas(
    sourceCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, 
    targetCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x = 0, y = 0
  ) {
    // Check if source canvas has any content
    const sourceData = sourceCtx.getImageData(0, 0, sourceCtx.canvas.width, sourceCtx.canvas.height);
    let hasContent = false;
    
    // Quick check for non-transparent pixels
    for (let i = 3; i < sourceData.data.length; i += 4) {
      if (sourceData.data[i] > 0) {
        hasContent = true;
        break;
      }
     
    }
    
    if (!hasContent) {
      // Canvas is empty, no need to draw
      return;
    }
  
    // Save current transform
    const currentTransform = targetCtx.getTransform();
    
    // Reset transform for 1:1 pixel mapping
    targetCtx.resetTransform();
    
    // Ensure both source and target have anti-aliasing disabled
    sourceCtx.imageSmoothingEnabled = false;
    targetCtx.imageSmoothingEnabled = false;
    
    // Use regular drawImage (faster and sufficient when combined with the other fixes)
    targetCtx.drawImage(sourceCtx.canvas, x, y);
    
    // Restore transform
    targetCtx.setTransform(currentTransform);
    // targetCtx = this.openCVService.quantifyToTwo(targetCtx)



  }
  public ensurePixelPerfectDrawing(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ) {
    ctx.imageSmoothingEnabled = false;
    // ctx.webkitImageSmoothingEnabled = false;
    // @ts-ignore - Some browsers might support these
    ctx.mozImageSmoothingEnabled = false;
    // @ts-ignore
    ctx.msImageSmoothingEnabled = false;
    if (ctx.canvas instanceof HTMLCanvasElement) {
      ctx.canvas.style.imageRendering = 'pixelated';
    }

    // Apply integer transforms
    const transform = ctx.getTransform();
    if (transform) {
      const roundedE = Math.round(transform.e);
      const roundedF = Math.round(transform.f);
      if (transform.e !== roundedE || transform.f !== roundedF) {
        ctx.setTransform(
          transform.a,
          transform.b,
          transform.c,
          transform.d,
          roundedE,
          roundedF
        );
      }
    }
  }
  clearCanvasAtIndex(index: number) {
    this.clearCanvas(this.canvasCtx[index]);
  }

  loadCanvas(data: string, index: number): Promise<boolean> {
    const img = new Image();
    img.src = data;
    return new Promise((resolve, reject) => {
      img.onload = () => {
        this.clearCanvas(this.canvasCtx[index]);
        this.canvasCtx[index].drawImage(img, 0, 0);
        resolve(true);
      };
    });
  }

  clearCanvas(ctx: OffscreenCanvasRenderingContext2D) {
    ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  resetCombinedCanvas() {
    this.clearCanvas(this.combinedCtx);
  }

  async loadAllCanvas(data: string[]) {
    for (let i = 0; i < data.length; i++) {
      await this.loadCanvas(data[i], i);
    }
  }

  getBufferCanvas() {
    return this.bufferCanvas;
  }

  getActiveCanvas() {
    let activeIndex = this.labelService.getActiveIndex();
    return this.labelCanvas[activeIndex];
  }

  getActiveCtx() {
    let activeIndex = this.labelService.getActiveIndex();
    return this.canvasCtx[activeIndex];
  }

  getBufferCtx() {
    return this.bufferCtx;
  }

  getCombinedCtx() {
    return this.combinedCtx;
  }

  getCombinedCanvas() {
    return this.combinedCanvas;
  }

  getActiveIndex() {
    return this.labelService.getActiveIndex();
  }
  getAllCanvasCtx() {
    return this.canvasCtx;
  }

  getAllCanvas() {
    return this.labelCanvas;
  }
}
