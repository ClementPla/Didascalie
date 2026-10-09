import { Injectable, Injector, inject } from '@angular/core';
import { EditorService } from '../../services/editor.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import { invoke } from '@tauri-apps/api/core';
import {
  applyRegionResult,
  componentsUnderStroke,
  unionPresence,
  intRect,
} from '../../../../core/misc/label-ops';
import { PostProcessOption } from '../../../../core/tools';
import { LabelsService } from '../../../../services/labels/labels.service';
import { ProjectService } from '../../../../services/project/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { findExperimentalPostProcess } from '../../../../experimental/registry';

/**
 * Runs the Rust post-process commands and writes their single-channel results
  * into the active label mask. Colour is resolved at composite time, from the
  * label palette.
 */
@Injectable({
  providedIn: 'root',
})
export class PostProcessService {
  private editorService = inject(EditorService);
  private imageProcessingService = inject(ImageAdjustmentService);
  private canvasManagerService = inject(CanvasManagerService);
  private stateService = inject(StateManagerService);
  private labelService = inject(LabelsService);
  private projectService = inject(ProjectService);
  private zoomPanService = inject(ZoomPanService);
  private injector = inject(Injector);

  private imageContext(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return null;
    return canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
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
    if (mask) applyRegionResult(mask, w, new Uint8Array(result), rect, this.labelService.paintValue(this.projectService.isInstanceSegmentation()));
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
      // Same refinement controls as the Otsu mode — both are stroke-bounded
      // selection operators and the panel presents them as one set.
      inverse: this.editorService.useInverse,
      opening: this.editorService.autoPostProcessOpening,
      kernelSize: this.editorService.morphoSize,
      connectedness: this.editorService.enforceConnectivity,
    });

    const mask = this.canvasManagerService.getActiveMask();
    if (mask) applyRegionResult(mask, w, new Uint8Array(result), rect, this.labelService.paintValue(this.projectService.isInstanceSegmentation()));
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
      case PostProcessOption.OTSU:
        return this.otsu_post_process();
      case PostProcessOption.FLOODFILL:
        return this.flood_fill_post_process();
      default: {
        // Experimental modes (MedSAM, superpixel, …) are resolved through the
        // registry so this service never imports experimental feature code.
        const experimental = findExperimentalPostProcess(
          this.editorService.postProcessOption
        );
        return experimental?.run(this.injector);
      }
    }
  }
}
