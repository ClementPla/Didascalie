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
  colorizeArrayInplace,
} from '../../../../../Core/misc/binarize';
import { OpenCVService } from '../../../../../Services/open-cv.service';
import { PostProcessOption } from '../../../../../Core/tools';
import { LabelsService } from '../../../../../Services/Project/labels.service';
import { from_hex_to_rgb } from '../../../../../Core/misc/colors';
import { ZoomPanService } from './zoom-pan.service';

@Injectable({
  providedIn: 'root',
})
export class PostProcessService {
  public featuresExtracted: boolean = false;
  constructor(
    private editorService: EditorService,
    private imageProcessingService: ImageProcessingService,
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private svgUIService: SVGUIService,
    private openCVService: OpenCVService,
    private labelService: LabelsService,
    private zoomPanService: ZoomPanService
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

  async crf_post_process() {
    {
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

      return invoke<Uint8ClampedArray>('crf_refine', {
        mask: maskData.buffer,
        image: imageData.buffer,
        width: rect.width,
        height: rect.height,
        spatialWeight: 3.0, // Lower value for spatial influence
        bilateralWeight: 5.0,
        numIterations: 50,
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
  }

  async flood_fill_post_process() {
    let rect = this.stateService.getBoundingBox();
    let bufferCtx = this.canvasManagerService.getBufferCtx();

    const imageData = this.imageProcessingService
      .getCurrentCanvas()
      .getContext('2d', { alpha: false })!
      .getImageData(rect.x, rect.y, rect.width, rect.height).data;

    const clickX = Math.floor(this.zoomPanService.currentPixel.x - rect.x);
    const clickY = Math.floor(this.zoomPanService.currentPixel.y - rect.y);
    const currentColor = this.labelService.activeLabel!.color;
    if (!currentColor) {
      return;
    }
    let rgbColor = from_hex_to_rgb(currentColor);
    console.log(rgbColor);
    return invoke<Uint8ClampedArray>('flood_fill_mask', {
      image: imageData.buffer,
      width: rect.width,
      height: rect.height,
      startX: clickX, // Relative to bounding box
      startY: clickY,
      tolerance: this.editorService.floodFillTolerance, // Delta E tolerance (0-100, typically 10-30 works well)
    }).then((mask: Uint8ClampedArray) => {
      const newMask = new ImageData(
        new Uint8ClampedArray(mask),
        rect.width,
        rect.height
      );
      colorizeArrayInplace(newMask.data, [
        rgbColor[0],
        rgbColor[1],
        rgbColor[2],
        255,
      ]);

      const activeCtx = this.canvasManagerService.getActiveCtx();
      bufferCtx.putImageData(newMask, rect.x, rect.y);
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

  async getPostProcessFunction(): Promise<void> {
    switch (this.editorService.postProcessOption) {
      case PostProcessOption.MEDSAM:
        return this.sam_post_process();
      case PostProcessOption.OTSU:
        return this.otsu_post_process();
      case PostProcessOption.CRF:
        return this.crf_post_process();
      case PostProcessOption.FLOODFILL:
        return this.flood_fill_post_process();
      default:
        return;
    }
  }
}
