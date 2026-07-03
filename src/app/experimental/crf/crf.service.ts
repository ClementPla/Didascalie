import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { binarizeArray, colorizeArrayInplace } from '../../Core/misc/binarize';
import { from_hex_to_rgb } from '../../Core/misc/colors';
import { CanvasManagerService } from '../../Components/pages/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../../Components/pages/editor/drawable-canvas/service/state-manager.service';
import { ImageAdjustmentService } from '../../Components/pages/editor/drawable-canvas/service/image-adjustment/image-adjustment.service';
import { LabelsService } from '../../Services/Labels/labels.service';

/**
 * Experimental: turn the current brush stroke into a segmentation with a
 * mean-field dense CRF (Rust `crf_refine` command). A GrabCut-style color model
 * — foreground learned from the stroke, background from the region border —
 * fills the object by color similarity, then a bilateral pairwise term snaps
 * the boundary onto color edges.
 */
@Injectable({ providedIn: 'root' })
export class CrfService {
  /** Shifts the foreground/background decision boundary. 0 keeps the color
   *  model's own split; positive grows the mask into more of the region,
   *  negative trims it back. */
  public growth = 0.3;
  /** Strength of the smoothness term: higher removes more speckle and rounds
   *  the border harder. */
  public smoothness = 3;
  /** How far (px) the mask may reach from the stroke — the padding added around
   *  the stroke's bounding box. Also pushes the background color samples
   *  further out, so widen it when the object is larger than the stroke. */
  public searchRadius = 24;

  // Fixed internals — good defaults; kept as constants so the settings UI stays
  // focused on the three parameters that matter in practice.
  /** Distance (RGB units) over which the FG/BG color decision softens. */
  private static readonly COLOR_SCALE = 22.0;
  /** Log-odds prior keeping painted pixels foreground. */
  private static readonly STROKE_BIAS = 2.5;
  /** Pairwise appearance coherence weight and bandwidths. */
  private static readonly EDGE_WEIGHT = 6.0;
  private static readonly EDGE_SPATIAL = 5.0;
  private static readonly EDGE_COLOR = 13.0;
  private static readonly ITERATIONS = 5;

  constructor(
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private imageProcessingService: ImageAdjustmentService,
    private labelService: LabelsService
  ) {}

  async refineStroke(): Promise<void> {
    const bbox = this.stateService.getBoundingBox();
    const imgWidth = this.stateService.width;
    const imgHeight = this.stateService.height;

    // Pad the stroke's bounding box so the CRF has room to push the boundary
    // outward toward nearby color edges (the raw bbox hugs the stroke).
    const pad = Math.round(this.searchRadius);
    const x0 = Math.max(0, Math.floor(bbox.x) - pad);
    const y0 = Math.max(0, Math.floor(bbox.y) - pad);
    const x1 = Math.min(imgWidth, Math.ceil(bbox.x + bbox.width) + pad);
    const y1 = Math.min(imgHeight, Math.ceil(bbox.y + bbox.height) + pad);
    const rect = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    if (rect.width <= 0 || rect.height <= 0) return;

    const bufferCtx = this.canvasManagerService.getBufferCtx();
    const maskData = bufferCtx.getImageData(
      rect.x,
      rect.y,
      rect.width,
      rect.height
    ).data;

    const canvas = this.imageProcessingService.getCurrentCanvas();
    if (!canvas) return;
    const imageData = (canvas.getContext('2d', { alpha: false }) as
      | CanvasRenderingContext2D
      | OffscreenCanvasRenderingContext2D
      | null)!.getImageData(rect.x, rect.y, rect.width, rect.height).data;

    const refined = await invoke<Uint8ClampedArray>('crf_refine', {
      image: imageData.buffer,
      mask: maskData.buffer,
      width: rect.width,
      height: rect.height,
      colorScale: CrfService.COLOR_SCALE,
      growth: this.growth,
      strokeBias: CrfService.STROKE_BIAS,
      edgeWeight: CrfService.EDGE_WEIGHT,
      edgeSpatial: CrfService.EDGE_SPATIAL,
      edgeColor: CrfService.EDGE_COLOR,
      smoothnessWeight: this.smoothness,
      numIterations: CrfService.ITERATIONS,
    });

    // Colorize the white/transparent mask with the active label color — grown
    // pixels are outside the original stroke, so we can't reuse its RGB.
    const activeColor = this.labelService.activeLabel?.color;
    const [r, g, b] = activeColor
      ? from_hex_to_rgb(activeColor)
      : binarizeArray(maskData).color;

    const newMask = new ImageData(
      new Uint8ClampedArray(refined),
      rect.width,
      rect.height
    );
    colorizeArrayInplace(newMask.data, [r, g, b, 255]);

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
  }
}
