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
import { OpenCVService } from '../../../../../Services/open-cv.service';

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
    private svgUIService: SVGUIService,
    private openCVService: OpenCVService
  ) {}

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
      console.log('Using cached features for SAM segmentation');
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
    }).then((mask: Uint8ClampedArray) => {
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

    let bbox = this.stateService.getBoundingBox();
    const maskCanvas = this.openCVService.getMaskOfConnectedComponentsInRegion(
      inputCtx,
      bufferCtx,
      bbox
    );
    const activeIndex = this.canvasManagerService.getActiveIndex();
    this.svgUIService.resetPath();

    this.canvasManagerService.getAllCanvasCtx().forEach((ctx, index) => {
      if (index !== activeIndex && !this.editorService.eraseAll) return;
      // ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(maskCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
    });
  }
}
