import { Injectable, Injector } from '@angular/core';
import { EditorService } from '../../services/editor.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import { invoke } from '@tauri-apps/api/core';
import { binarizeArray } from '../../../../../Core/misc/binarize';
import {
  applyResultMask,
  applyRegionResult,
  componentsUnderStroke,
  unionPresence,
  intRect,
} from '../../../../../Core/misc/label-ops';
import { PostProcessOption } from '../../../../../Core/tools';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { ProjectService } from '../../../../../Services/ProjectService/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { findExperimentalPostProcess } from '../../../../../experimental/registry';

/**
 * Runs the Rust post-process commands and writes their single-channel results
 * into the active label mask. Colour is no longer applied here — it lives in
 * the label palette and is resolved at composite time.
 */
@Injectable({
  providedIn: 'root',
})
export class PostProcessService {
  public featuresExtracted = false;
  constructor(
    private editorService: EditorService,
    private imageProcessingService: ImageAdjustmentService,
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private labelService: LabelsService,
    private projectService: ProjectService,
    private zoomPanService: ZoomPanService,
    private injector: Injector
  ) {}

  /** Active mask value to write: instance id, or 1 for semantic labels. */
  private activeValue(): number {
    if (this.projectService.isInstanceSegmentation()) {
      const v = this.labelService.activeSegInstance?.instance ?? 1;
      return Math.min(255, Math.max(1, Math.round(v)));
    }
    return 1;
  }

  private imageContext(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return null;
    return canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
  }

  async sam_post_process() {
    const w = this.stateService.width;
    const h = this.stateService.height;

    // SAM reads the whole stroke buffer + full image at native resolution, which
    // isn't available in the windowed/viewport-composite mode used for large
    // images. Skip rather than send a truncated mask.
    if (this.canvasManagerService.usesViewportComposite) {
      console.warn('SAM post-process is unavailable for large images.');
      return;
    }

    const bufferCtx = this.canvasManagerService.getBufferCtx();
    const coarseMask = binarizeArray(bufferCtx.getImageData(0, 0, w, h).data).data;

    const imgCtx = this.imageContext();
    if (!imgCtx) return;
    const imgData = imgCtx.getImageData(0, 0, w, h).data;

    const result = await invoke<ArrayBufferLike>('mask_sam_segment', {
      coarseMask,
      image: this.featuresExtracted ? [] : imgData.buffer,
      threshold: this.editorService.samThreshold,
      width: w,
      height: h,
      extractFeatures: !this.featuresExtracted,
    });
    this.featuresExtracted = true;

    const mask = this.canvasManagerService.getActiveMask();
    if (mask) applyResultMask(mask, new Uint8Array(result), this.activeValue());
  }

  async otsu_post_process() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const rect = intRect(this.stateService.getBoundingBox(), w, h);
    if (!rect) return;

    const imgCtx = this.imageContext();
    if (!imgCtx) return;
    const imageData = imgCtx.getImageData(rect.x, rect.y, rect.width, rect.height).data;
    const maskData = this.canvasManagerService.readBufferRegion(rect);

    const result = await invoke<ArrayBufferLike>('otsu_segmentation', {
      mask: maskData.buffer,
      image: imageData.buffer,
      opening: this.editorService.autoPostProcessOpening,
      inverse: this.editorService.useInverse,
      kernelSize: this.editorService.morphoSize,
      connectedness: this.editorService.enforceConnectivity,
      width: rect.width,
      height: rect.height,
    });

    const mask = this.canvasManagerService.getActiveMask();
    if (mask) applyRegionResult(mask, w, new Uint8Array(result), rect, this.activeValue());
  }

  async flood_fill_post_process() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const rect = intRect(this.stateService.getBoundingBox(), w, h);
    if (!rect) return;

    const imgCtx = this.imageContext();
    if (!imgCtx) return;
    const imageData = imgCtx.getImageData(rect.x, rect.y, rect.width, rect.height).data;

    const clickX = Math.floor(this.zoomPanService.currentPixel.x - rect.x);
    const clickY = Math.floor(this.zoomPanService.currentPixel.y - rect.y);

    const result = await invoke<ArrayBufferLike>('flood_fill_mask', {
      image: imageData.buffer,
      width: rect.width,
      height: rect.height,
      startX: clickX,
      startY: clickY,
      tolerance: this.editorService.floodFillTolerance,
    });

    const mask = this.canvasManagerService.getActiveMask();
    if (mask) applyRegionResult(mask, w, new Uint8Array(result), rect, this.activeValue());
  }

  /**
   * Erase the connected components (across the active mask, or every mask when
   * "erase all" is on) that the eraser stroke touched.
   */
  async eraseConnectedComponents_post_process() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const rect = intRect(this.stateService.getBoundingBox(), w, h);
    if (!rect) return;

    const region = this.canvasManagerService.readBufferRegion(rect);

    const masks = this.canvasManagerService.getAllMasks();
    const activeIndex = this.canvasManagerService.getActiveIndex();
    const eraseAll = this.editorService.eraseAll;

    const presence = eraseAll ? unionPresence(masks, w, h) : masks[activeIndex];
    if (!presence) return;

    const toClear = componentsUnderStroke(presence, w, h, region, rect);
    const targets = eraseAll ? masks : [masks[activeIndex]].filter(Boolean);
    for (const px of toClear) {
      for (const mask of targets) mask[px] = 0;
    }
  }

  async getPostProcessFunction(): Promise<void> {
    switch (this.editorService.postProcessOption) {
      case PostProcessOption.MEDSAM:
        return this.sam_post_process();
      case PostProcessOption.OTSU:
        return this.otsu_post_process();
      case PostProcessOption.FLOODFILL:
        return this.flood_fill_post_process();
      default: {
        // Experimental modes (CRF, superpixel, …) are resolved through the
        // registry so this service never imports experimental feature code.
        const experimental = findExperimentalPostProcess(
          this.editorService.postProcessOption
        );
        return experimental?.run(this.injector);
      }
    }
  }
}
