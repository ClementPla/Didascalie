import { Injectable, Injector, inject } from '@angular/core';
import { api, RefineOptions } from '../../../../lib/api';
import { EditorService } from '../../services/editor.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import {
  applyRegionResult,
  componentsUnderStroke,
  unionPresence,
} from '../../../../core/misc/label-ops';
import { PostProcessOption } from '../../../../core/tools';
import { LabelsService } from '../../../../services/labels/labels.service';
import { ProjectService } from '../../../../services/project/project.service';
import { ZoomPanService } from './zoom-pan.service';
import { SequenceService } from '../../../../services/sequence.service';
import { findExperimentalPostProcess } from '../../../../experimental/registry';
import { PaintTarget, capturePaintTarget, isStillTarget } from './paint-target';

/** Runs the Rust post-process commands and writes their results into the
 *  active label mask. */
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
  private sequenceService = inject(SequenceService);
  private injector = inject(Injector);

  private imageContext(): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null {
    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return null;
    return canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null;
  }

  /** The refinement options Otsu and flood fill share. */
  private refinement(): RefineOptions {
    const { smoothing, lineWidth, useInverse, fillHoles, enforceConnectivity } =
      this.editorService;
    return {
      inverse: useInverse,
      // At 100 %, what is narrower than about half the brush is rounded off.
      smooth: (smoothing / 100) * (lineWidth / 3),
      fillHoles,
      connectedness: enforceConnectivity,
    };
  }

  /** The open frame when it is a render of raw pixels, and the channel the
   *  operators read (null: the brightest visible). Null for an 8-bit image,
   *  which the operators read from the canvas. */
  private rawTarget(): { frameId: number; source: number | null } | null {
    const info = this.sequenceService.currentPixelInfo();
    const frameId = this.sequenceService.currentFrame()?.id;
    if (!info || frameId == null) return null;
    const channel = this.editorService.operatorChannel;
    return { frameId, source: channel !== null && channel < info.channels ? channel : null };
  }

  private target(): PaintTarget | null {
    return capturePaintTarget(this.canvasManagerService, this.stateService, this.sequenceService);
  }

  /** Write a region result into the mask the stroke was made on, unless the
   *  frame or label changed while it was computed. */
  private applyResult(
    result: ArrayBufferLike,
    rect: { x: number; y: number; width: number; height: number },
    target: PaintTarget,
  ) {
    if (!isStillTarget(target, this.canvasManagerService, this.stateService, this.sequenceService)) return;
    applyRegionResult(
      target.mask,
      target.width,
      new Uint8Array(result),
      rect,
      this.labelService.paintValue(this.projectService.isInstanceSegmentation()),
    );
  }

  async otsu_post_process() {
    const rect = this.stateService.strokeRect();
    if (!rect) return;
    const target = this.target();
    if (!target) return;

    const raw = this.rawTarget();
    if (raw) {
      const maskData = this.canvasManagerService.readBufferRegion(rect);
      const result = await api.otsuSegmentationRaw({
        ...raw,
        ...rect,
        mask: maskData.buffer,
        denoiseSigma: this.editorService.denoise,
        ...this.refinement(),
      });
      this.applyResult(result, rect, target);
      return;
    }

    const imgCtx = this.imageContext();
    if (!imgCtx) return;
    const imageData = imgCtx.getImageData(rect.x, rect.y, rect.width, rect.height).data;
    const maskData = this.canvasManagerService.readBufferRegion(rect);

    const result = await api.otsuSegmentation({
      mask: maskData.buffer,
      image: imageData.buffer,
      denoiseSigma: this.editorService.denoise,
      ...this.refinement(),
      width: rect.width,
      height: rect.height,
    });
    this.applyResult(result, rect, target);
  }

  async flood_fill_post_process() {
    const rect = this.stateService.strokeRect();
    if (!rect) return;
    const target = this.target();
    if (!target) return;

    const clickX = Math.floor(this.zoomPanService.currentPixel.x - rect.x);
    const clickY = Math.floor(this.zoomPanService.currentPixel.y - rect.y);

    const raw = this.rawTarget();
    if (raw) {
      const result = await api.floodFillRaw({
        ...raw,
        ...rect,
        startX: clickX,
        startY: clickY,
        tolerance: this.editorService.floodFillTolerance,
        ...this.refinement(),
      });
      this.applyResult(result, rect, target);
      return;
    }

    const imgCtx = this.imageContext();
    if (!imgCtx) return;
    const imageData = imgCtx.getImageData(rect.x, rect.y, rect.width, rect.height).data;

    const result = await api.floodFillMask({
      image: imageData.buffer,
      width: rect.width,
      height: rect.height,
      startX: clickX,
      startY: clickY,
      tolerance: this.editorService.floodFillTolerance,
      ...this.refinement(),
    });
    this.applyResult(result, rect, target);
  }

  /** Erase the connected components the eraser stroke touched, in the active
   *  mask or in every mask ("erase all"). */
  async eraseConnectedComponents_post_process() {
    const w = this.stateService.width;
    const h = this.stateService.height;
    const rect = this.stateService.strokeRect();
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
        // Experimental modes come from the registry.
        const experimental = findExperimentalPostProcess(
          this.editorService.postProcessOption
        );
        return experimental?.run(this.injector);
      }
    }
  }
}
