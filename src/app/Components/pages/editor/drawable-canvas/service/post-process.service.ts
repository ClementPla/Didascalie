import { Injectable, input } from '@angular/core';
import { EditorService } from '../../services/editor.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import { invoke } from '@tauri-apps/api/core';
import {
  binarizeArray,
  colorizeArray,
  colorizeArrayInplace,
} from '../../../../../Core/misc/binarize';
import { OpenCVService } from '../../../../../Services/open-cv.service';
import { PostProcessOption } from '../../../../../Core/tools';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { from_hex_to_rgb } from '../../../../../Core/misc/colors';
import { ZoomPanService } from './zoom-pan.service';

@Injectable({
  providedIn: 'root',
})
export class PostProcessService {
  public featuresExtracted: boolean = false;
  public superpixelComputed: boolean = false;
  /** Cached superpixel boundary overlay at image-native resolution, drawn by
   *  the canvas component when `editorService.showSuperpixels` is on. */
  public superpixelOverlayCanvas: OffscreenCanvas | null = null;
  constructor(
    private editorService: EditorService,
    private imageProcessingService: ImageAdjustmentService,
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
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
    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;
    const imgData = (canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)!
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

  async superpixel_post_process() {
    let bufferCtx = this.canvasManagerService.getBufferCtx();
    let rect = {
      x: 0,
      y: 0,
      width: this.stateService.width,
      height: this.stateService.height,
    };

    // The buffer holds the brush stroke; keep its color for the refined output.
    const maskData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;
    let out = binarizeArray(maskData);
    let currentColor = out.color;

    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;
    const imgData = (canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null)!.getImageData(rect.x, rect.y, rect.width, rect.height).data;

    // Compute the superpixel map on the first stroke of an image, reuse after
    // (mirrors the SAM feature-extraction flag). The command returns an RGBA
    // mask (white/transparent), like flood_fill.
    const mask = await invoke<Uint8ClampedArray>('superpixel_refine', {
      image: this.superpixelComputed ? [] : imgData.buffer,
      brush: maskData.buffer,
      width: rect.width,
      height: rect.height,
      computeMap: !this.superpixelComputed,
      targetCount: this.editorService.superpixelCount,
      similarityThreshold: this.editorService.superpixelThreshold,
      minOverlapFraction: this.editorService.superpixelMinOverlap,
    });
    this.superpixelComputed = true;

    const newMask = new ImageData(
      new Uint8ClampedArray(mask),
      rect.width,
      rect.height
    );
    colorizeArrayInplace(newMask.data, [
      currentColor[0],
      currentColor[1],
      currentColor[2],
      255,
    ]);

    const activeCtx = this.canvasManagerService.getActiveCtx();
    bufferCtx.putImageData(newMask, rect.x, rect.y);
    activeCtx.drawImage(bufferCtx.canvas, 0, 0);
  }

  /** Invalidate the cached superpixel map/overlay (e.g. when the target count
   *  changes) so the next stroke or overlay refresh recomputes it. */
  invalidateSuperpixels() {
    this.superpixelComputed = false;
    this.superpixelOverlayCanvas = null;
  }

  /** Fetch (building the map on demand) and cache the superpixel boundary
   *  overlay, then request a redraw. Clears the overlay when the toggle is off. */
  async updateSuperpixelOverlay() {
    if (!this.editorService.showSuperpixels) {
      this.superpixelOverlayCanvas = null;
      this.canvasManagerService.requestRedraw.next(true);
      return;
    }

    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;
    const width = this.stateService.width;
    const height = this.stateService.height;
    const imgData = (canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null)!.getImageData(0, 0, width, height).data;

    const overlay = await invoke<Uint8ClampedArray>('superpixel_overlay', {
      image: this.superpixelComputed ? [] : imgData.buffer,
      width,
      height,
      computeMap: !this.superpixelComputed,
      targetCount: this.editorService.superpixelCount,
    });
    this.superpixelComputed = true;

    const off = new OffscreenCanvas(width, height);
    off
      .getContext('2d')!
      .putImageData(
        new ImageData(new Uint8ClampedArray(overlay), width, height),
        0,
        0
      );
    this.superpixelOverlayCanvas = off;
    this.canvasManagerService.requestRedraw.next(true);
  }

  async otsu_post_process() {
    const rect = this.stateService.getBoundingBox();
    let bufferCtx = this.canvasManagerService.getBufferCtx();

    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;

    const imageData = (canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)?.getImageData(rect.x, rect.y, rect.width, rect.height).data;
    if (!imageData) return;

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

      const canvas = this.imageProcessingService.getCurrentCanvas();
      if (!canvas) return;

      const imageData = (canvas.getContext('2d', { alpha: false }) as
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)!.getImageData(rect.x, rect.y, rect.width, rect.height).data;

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
    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;

    const imageData = (canvas.getContext('2d', { alpha: false }) as
  CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null)!.getImageData(rect.x, rect.y, rect.width, rect.height).data;

    const clickX = Math.floor(this.zoomPanService.currentPixel.x - rect.x);
    const clickY = Math.floor(this.zoomPanService.currentPixel.y - rect.y);
    const currentColor = this.labelService.activeLabel!.color;
    if (!currentColor) {
      return;
    }
    let rgbColor = from_hex_to_rgb(currentColor);
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
      case PostProcessOption.SUPERPIXEL:
        return this.superpixel_post_process();
      default:
        return;
    }
  }
}
