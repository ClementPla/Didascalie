import { Injectable, input } from '@angular/core';
import { EditorService } from '../../../../../Services/UI/editor.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageProcessingService } from './image-processing.service';
import { invoke } from '@tauri-apps/api/core';
import { BboxManagerService } from './bbox-manager.service';
import { SVGUIService } from './svgui.service';
import {
  binarizeArray,
  colorizeArray,
} from '../../../../../Core/misc/binarize';

@Injectable({
  providedIn: 'root',
})
export class PostProcessService {
  public featuresExtracted: boolean = false;
  constructor(
    private editorService: EditorService,
    private imageProcessingService: ImageProcessingService,
    private canvasManagerService: CanvasManagerService,
    private bboxManager: BboxManagerService,
    private stateService: StateManagerService,
    private svgUIService: SVGUIService
  ) {}

  postProcess() {}

  async crf_post_process() {
    let bufferCtx = this.canvasManagerService.getBufferCtx();
    let rect = this.stateService.getBoundingBox();
    const maskData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;

    const imgData = this.imageProcessingService
      .getCurrentCanvas()
      .getContext('2d', { alpha: false })!
      .getImageData(rect.x, rect.y, rect.width, rect.height).data;
    let timer = performance.now();
    return invoke<ArrayBufferLike>('crf_refine', {
      mask: maskData.buffer,
      image: imgData.buffer,
      width: rect.width,
      height: rect.height,
      spatialWeight: 0.25,
      bilateralWeight: 2.0,
      numIterations: 50,
    }).then((imageBitmap: ArrayBufferLike) => {
      console.log('CRF took', performance.now() - timer);
      let activeCtx = this.canvasManagerService.getActiveCtx();
      let bufferCanvas = this.canvasManagerService.getBufferCanvas();
      bufferCtx.putImageData(
        new ImageData(
          new Uint8ClampedArray(imageBitmap),
          rect.width,
          rect.height
        ),
        rect.x,
        rect.y
      );
      activeCtx.drawImage(bufferCanvas, 0, 0);
    });
  }

  async sam_post_process() {
    let bufferCtx = this.canvasManagerService.getBufferCtx();
    let bbox = this.stateService.getBoundingBox();
    let rect = {
      x: 0,
      y: 0,
      width: this.stateService.width,
      height: this.stateService.height,
    };
    const maskData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;

    let out = binarizeArray(maskData);

    // Binary mask
    let currentColor = out.color;
    let binaryMask = out.data;

    const imgData = this.imageProcessingService
      .getCurrentCanvas()
      .getContext('2d', { alpha: false })!
      .getImageData(
        0,
        0,
        this.stateService.width,
        this.stateService.height
      ).data;
    let imageBitmap: ArrayBufferLike;
    if (!this.featuresExtracted) {
      imageBitmap = await invoke<ArrayBufferLike>('mask_sam_segment', {
        coarseMask: binaryMask,
        image: imgData.buffer,
        threshold: this.editorService.samThreshold,
        width: this.stateService.width,
        height: this.stateService.height,
        extractFeatures: true,
      });
    } else {
      imageBitmap = await invoke<ArrayBufferLike>('mask_sam_segment', {
        coarseMask: binaryMask,
        image: [],
        threshold: this.editorService.samThreshold,
        width: this.stateService.width,
        height: this.stateService.height,
        extractFeatures: false,
      });
    }
    let outBuffer = new Uint8ClampedArray(imageBitmap);
    // imageBitmap is a grayscale image with the same size as the input image.
    let outData = colorizeArray(outBuffer, [
      currentColor[0],
      currentColor[1],
      currentColor[2],
      255,
    ]);

    this.featuresExtracted = true;
    let activeCtx = this.canvasManagerService.getActiveCtx();
    let bufferCanvas = this.canvasManagerService.getBufferCanvas();
    bufferCtx.putImageData(
      new ImageData(outData, rect.width, rect.height),
      rect.x,
      rect.y
    );
    bufferCtx.globalCompositeOperation = 'destination-in';
    bufferCtx.fillStyle = 'white';
    bufferCtx.fillRect(bbox.x, bbox.y, bbox.width, bbox.height);
    bufferCtx.globalCompositeOperation = 'source-over';
    activeCtx.drawImage(bufferCanvas, 0, 0);
  }

  async otsu_post_process() {
    const rect = this.stateService.getBoundingBox();
    let bufferCtx = this.canvasManagerService.getBufferCtx();

    const imageData = this.imageProcessingService
      .getCurrentCanvas()
      .getContext('2d', { alpha: false })!
      .getImageData(rect.x, rect.y, rect.width, rect.height).data;

    const maskData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;

    return invoke<Uint8ClampedArray>('otsu_segmentation', {
      mask: maskData.buffer,
      image: imageData.buffer,
      opening: this.editorService.autoPostProcessOpening,
      inverse: this.editorService.useInverse,
      kernelSize: this.editorService.morphoSize,
      connectedness: this.editorService.enforceConnectivity,
      width: rect.width,
      height: rect.height,
    }).then((mask: ArrayBufferLike) => {
      const newMAsk = new ImageData(
        new Uint8ClampedArray(mask),
        rect.width,
        rect.height
      );
      const activeCtx = this.canvasManagerService.getActiveCtx();
      bufferCtx.putImageData(newMAsk, rect.x, rect.y);
      activeCtx.drawImage(
        bufferCtx.canvas,
        rect.x,
        rect.y,
        rect.width,
        rect.height,
        rect.x,
        rect.y,
        rect.width,
        rect.height
      );
    });
  }

  async eraseAll_post_process() {
    let bufferCtx = this.canvasManagerService.getBufferCtx();
    let rect = {
      x: 0,
      y: 0,
      width: this.stateService.width,
      height: this.stateService.height,
    };

    let inputCtx;
    if (this.editorService.eraseAll) {
      if (this.editorService.edgesOnly) {
        this.editorService.edgesOnly = false;
        this.canvasManagerService.computeCombinedCanvas();
        this.editorService.edgesOnly = true;
      }

      inputCtx = this.canvasManagerService.getCombinedCtx();
    } else {
      inputCtx = this.canvasManagerService.getActiveCtx();
    }

    const maskData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;

    const labelData = inputCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;

    const maskOut = binarizeArray(maskData);
    const labelOut = binarizeArray(labelData);

    const activeIndex = this.canvasManagerService.getActiveIndex();
    return invoke<ArrayBufferLike>('get_overlapping_region_with_mask', {
      label: labelOut.data,
      mask: maskOut.data,
      width: rect.width,
      height: rect.height,
    }).then((mask: ArrayBufferLike) => {
      this.svgUIService.resetPath();

      let array = colorizeArray(new Uint8ClampedArray(mask), [0, 0, 0, 255]);
      const newMAsk = new ImageData(array, rect.width, rect.height);
      bufferCtx.putImageData(newMAsk, 0, 0);
      this.canvasManagerService.getAllCanvasCtx().forEach((ctx, index) => {
        if (index !== activeIndex && !this.editorService.eraseAll) return;
        ctx.globalCompositeOperation = 'destination-out';
        ctx.drawImage(
          bufferCtx.canvas,
          rect.x,
          rect.y,
          rect.width,
          rect.height
        );
        ctx.globalCompositeOperation = 'source-over';
      });
    });
  }
}
