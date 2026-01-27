import { Injectable } from '@angular/core';
import { StateManagerService } from './state-manager.service';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { OpenCVService } from '../../../../../Services/open-cv.service';
import { EditorService } from '../../services/editor.service';
import { Subject } from 'rxjs';
import { BboxManagerService } from './bbox-manager.service';
import { CombinedLabel } from '../../../../../Core/interface';
import { WebGPUCanvasCompositorService } from './web-gpucanvas-compositor.service';

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
  private useWebGPU = false;
  constructor(
    private stateService: StateManagerService,
    private labelService: LabelsService,
    private openCVService: OpenCVService,
    private editorService: EditorService,
    private bboxManager: BboxManagerService,
    private webgpuCompositor: WebGPUCanvasCompositorService
  ) {
    this.initializeWebGPU();
  }

  private async initializeWebGPU(): Promise<void> {
    this.useWebGPU = await this.webgpuCompositor.initialize();
    console.log(
      `Using ${this.useWebGPU ? 'WebGPU' : 'CPU'} for canvas composition`
    );
  }
  debugCheckBinary(ctx: OffscreenCanvasRenderingContext2D, label: string) {
    const imgData = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
    const data = imgData.data;

    let nonBinaryCount = 0;
    const nonBinaryValues = new Set<number>();

    for (let i = 3; i < data.length; i += 4) {
      const alpha = data[i];
      if (alpha !== 0 && alpha !== 255) {
        nonBinaryCount++;
        nonBinaryValues.add(alpha);
      }
    }

    if (nonBinaryCount > 0) {
      console.warn(
        `${label}: Found ${nonBinaryCount} non-binary alpha pixels. Values:`,
        [...nonBinaryValues].sort((a, b) => a - b)
      );
    } else {
      console.log(`${label}: All pixels are binary (0 or 255)`);
    }
  }

  async computeCombinedCanvas() {
   
    this.bboxManager.clear();
    if (this.useWebGPU && this.editorService.webGPURendering) {
      await this.computeCombinedCanvasGPU();
    } else {
      this.computeCombinedCanvasCPU();
    }
    if (this.editorService.showBoundingBox) {
      if (this.editorService.labelledCombinedBoundingBox) {
        let boundingBox = this.openCVService.findBoundingBox(this.combinedCtx);
        this.bboxManager.addBboxes(boundingBox, CombinedLabel);
      } else {
        this.labelCanvas.forEach((canvas, index) => {
          if (!this.labelService.listSegmentationLabels[index].isVisible) {
            return;
          }
          let boundingBox = this.openCVService.findBoundingBox(
            this.canvasCtx[index]
          );
          this.bboxManager.addBboxes(
            boundingBox,
            this.labelService.listSegmentationLabels[index]
          );
        });
      }
    }
  }

  initCanvas() {
    this.labelCanvas = [];
    this.canvasCtx = [];
    this.labelService.listSegmentationLabels.forEach((label) => {
      const canvas = new OffscreenCanvas(
        this.stateService.width,
        this.stateService.height
      );
      this.labelCanvas.push(canvas);
      this.canvasCtx.push(canvas.getContext('2d', { alpha: true })!);
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
    })!;
  }

  private async computeCombinedCanvasGPU() {
    const width = this.stateService.width;
    const height = this.stateService.height;
    try {
      if (this.webgpuCompositor.isInitialized) {
        // 1. GPU Composite
        const visibility = this.labelService.listSegmentationLabels.map(
          (l) => l.isVisible
        );

        // 1. Await the actual GPU processing
        const imageData = await this.webgpuCompositor.compositeCanvases(
          this.labelCanvas,
          visibility,
          width,
          height,
          this.editorService.edgesOnly
        );

        this.combinedCtx.putImageData(imageData, 0, 0);
      }
    } catch (error) {
      console.error('WebGPU composition failed, falling back to CPU:', error);
      this.computeCombinedCanvasCPU();
    }
  }

  computeCombinedCanvasCPU() {
    this.combinedCtx.clearRect(
      0,
      0,
      this.stateService.width,
      this.stateService.height
    );
    this.bboxManager.clear();

    this.ensurePixelPerfectDrawing(this.combinedCtx);
    this.labelCanvas.forEach((canvas, index) => {
      if (!this.labelService.listSegmentationLabels[index].isVisible) {
        return;
      }

      this.drawCanvasToCanvas(this.canvasCtx[index], this.combinedCtx);
      if (
        this.editorService.showBoundingBox &&
        !this.editorService.labelledCombinedBoundingBox
      ) {
        let boundingBox = this.openCVService.findBoundingBox(
          this.canvasCtx[index]
        );
        this.bboxManager.addBboxes(
          boundingBox,
          this.labelService.listSegmentationLabels[index]
        );
      }
    });

    if (this.editorService.edgesOnly) {
      let edge = this.openCVService.edgeDetection_v2(this.combinedCtx);
      this.combinedCtx.clearRect(
        0,
        0,
        this.stateService.width,
        this.stateService.height
      );
      const edgeCtx = edge.getContext(
        '2d'
      ) as OffscreenCanvasRenderingContext2D;

      this.drawCanvasToCanvas(edgeCtx, this.combinedCtx);
    }
  }

  public drawCanvasToCanvas(
    sourceCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    targetCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    x = 0,
    y = 0
  ) {
    // 1. Force integer dimensions to prevent the "long value range" error
    const w = Math.floor(sourceCtx.canvas.width);
    const h = Math.floor(sourceCtx.canvas.height);

    if (w <= 0 || h <= 0) return;

    // 2. Perform the draw
    const currentTransform = targetCtx.getTransform();
    targetCtx.resetTransform();

    sourceCtx.imageSmoothingEnabled = false;
    targetCtx.imageSmoothingEnabled = false;

    targetCtx.drawImage(sourceCtx.canvas, x, y);

    targetCtx.setTransform(currentTransform);
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
    this.stateService.recomputeCanvasSum = true;
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

  clearAllCanvas() {
    this.labelCanvas.forEach((canvas) => {
      this.clearCanvas(canvas.getContext('2d')!);
    });
    this.resetCombinedCanvas();
    this.bboxManager.clear();
  }

  async updateCanvasesDimensions() {
    await this.webgpuCompositor.prepareResources(
      this.stateService.width,
      this.stateService.height,
      this.labelCanvas.length
    );
    if (this.labelCanvas.length == 0) {
      this.initCanvas();
    }
    this.labelCanvas.forEach((canvas) => {
      if (
        canvas.width !== this.stateService.width ||
        canvas.height !== this.stateService.height
      ) {
        canvas.width = this.stateService.width;
        canvas.height = this.stateService.height;
      }
    });

    if (
      this.combinedCanvas.width !== this.stateService.width ||
      this.combinedCanvas.height !== this.stateService.height
    ) {
      this.combinedCanvas.width = this.stateService.width;
      this.combinedCanvas.height = this.stateService.height;
    }
    if (
      this.bufferCanvas.width !== this.stateService.width ||
      this.bufferCanvas.height !== this.stateService.height
    ) {
      this.bufferCanvas.width = this.stateService.width;
      this.bufferCanvas.height = this.stateService.height;
    }
  }

  
}
