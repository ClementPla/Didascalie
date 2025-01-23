import { Injectable, input } from '@angular/core';
import { EditorService } from '../../../../../Services/UI/editor.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageProcessingService } from './image-processing.service';
import { invoke } from '@tauri-apps/api/core';
import { BboxManagerService } from './bbox-manager.service';
import { SVGUIService } from './svgui.service';

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
  ) { }

  postProcess() { }

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
    const imgData = this.imageProcessingService
      .getCurrentCanvas()
      .getContext('2d', { alpha: false })!
      .getImageData(
        0,
        0,
        this.stateService.width,
        this.stateService.height
      ).data;
    let timer = performance.now();
    return invoke<ArrayBufferLike>('mask_sam_segment', {
      coarseMask: maskData.buffer,
      image: imgData.buffer,
      threshold: this.editorService.samThreshold,
      width: this.stateService.width,
      height: this.stateService.height,
      extractFeatures: !this.featuresExtracted,
    }).then((imageBitmap: ArrayBufferLike) => {
      console.log('SAM took', performance.now() - timer, 'ms');
      timer = performance.now();
      this.featuresExtracted = true;
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
      // Clear everything outside the bounding box

      bufferCtx.globalCompositeOperation = 'destination-in';
      bufferCtx.fillStyle = 'white';
      bufferCtx.fillRect(bbox.x, bbox.y, bbox.width, bbox.height);
      bufferCtx.globalCompositeOperation = 'source-over';
      activeCtx.drawImage(bufferCanvas, 0, 0);
      console.log('Drawing took', performance.now() - timer);
    });
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

    const activeIndex = this.canvasManagerService.getActiveIndex();
    return invoke<ArrayBufferLike>('get_overlapping_region_with_mask', {
      label: labelData.buffer,
      mask: maskData.buffer,
      width: rect.width,
      height: rect.height,
    }).then((mask: ArrayBufferLike) => {
      this.svgUIService.resetPath();
      const newMAsk = new ImageData(
        new Uint8ClampedArray(mask),
        rect.width,
        rect.height
      );
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

  async drawQuadTreeBbox(
    maskData: Uint8ClampedArray,
    minSize: number,
    maxDepth: number
  ) {
    const w = this.stateService.width;
    const h = this.stateService.height;
    return invoke('get_quad_tree_bbox', {
      mask: maskData.buffer,
      width: this.stateService.width,
      height: this.stateService.height,
      newWidth: 256,
      newHeight: 256,
      maxDepth: maxDepth,
      minSize: minSize,
    })
      .then((bboxes: any) => {
        let N = bboxes.length;
        this.bboxManager.listBbox = [];
        for (let i = 0; i < N; i++) {
          const bbox = bboxes[i];
          const xmin = (w / 256) * bbox[0];
          const ymin = (h / 256) * bbox[1];
          const xmax = (w / 256) * bbox[2];
          const ymax = (h / 256) * bbox[3];
          // xmin, xmax are in [0, 1024], ymin, ymax are in [0, 1024].

          const b = {
            x: xmin,
            y: ymin,
            width: xmax - xmin,
            height: ymax - ymin,
          };
          this.bboxManager.listBbox.push({
            label: {
              label: 'bbox' + i,
              color: '#FF0000',
              isVisible: true,
              shades: null,
            },
            bbox: b,
            instance: i,
          });
        }
      })
      .then(() => {
        setTimeout(() => {
          this.bboxManager.listBbox = [];
        }, 2000);
      });
  }
}
