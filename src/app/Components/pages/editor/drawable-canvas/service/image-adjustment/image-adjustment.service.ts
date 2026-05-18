// image-adjustment.service.ts

import { Injectable, OnDestroy } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { EditorService } from '../../../services/editor.service';
import {
  AdjustmentState,
  ChannelAdjustments,
  Channel,
  CHANNELS,
  CurvePoints,
  Histogram,
  RGBLUT,
  autoStretchAdjustment,
  composeRGBLUT,
  computeHistogram,
  equalizeCurve,
  isIdentity,
  makeIdentityAdjustments,
  makeIdentityState,
} from './image-processing.model';
import { ImageAdjustmentRenderer } from './image-adjustement.renderer';

@Injectable({ providedIn: 'root' })
export class ImageAdjustmentService implements OnDestroy {
  // Public state, mutated by the UI.
  public state: AdjustmentState = makeIdentityState();

  // Notifies subscribers when output canvas changes (renderer may run async).
  public output$ = new BehaviorSubject<HTMLCanvasElement | OffscreenCanvas | null>(null);
  public histogram$ = new BehaviorSubject<Histogram | null>(null);

  private sourceImage: HTMLImageElement | null = null;
  private sourceCanvas: HTMLCanvasElement | null = null;
  private renderer = new ImageAdjustmentRenderer();
  private rendering = false;
  private renderQueued = false;

  constructor(private editorService: EditorService) {
    // Fire and forget; CPU fallback used until ready.
    this.renderer.initialize();
  }

  ngOnDestroy(): void {
    this.renderer.destroy();
  }

  // ==========================================
  // Image lifecycle
  // ==========================================

  setImage(img: HTMLImageElement): void {
    this.sourceImage = img;
    this.sourceCanvas = document.createElement('canvas');
    this.sourceCanvas.width = img.width;
    this.sourceCanvas.height = img.height;
    const ctx = this.sourceCanvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);

    // Recompute histogram for the new image (off the main render path).
    queueMicrotask(() => this.recomputeHistogram());

    // Emit either the source (identity) or a rendered version.
    this.scheduleRender();
  }

  /**
   * Returns the canvas to draw on screen. Synchronous: if adjustments are at
   * identity, the source is returned directly. Otherwise the last rendered
   * output is returned, and a render is scheduled in the background.
   *
   * The orchestrator should subscribe to `output$` to be notified when an
   * async render completes.
   */
  getCurrentCanvas(): HTMLCanvasElement | OffscreenCanvas | null {
    if (!this.sourceCanvas) return null;
    if (isIdentity(this.state) || !this.editorService.useProcessing) {
      return this.sourceCanvas;
    }
    return this.output$.value ?? this.sourceCanvas;
  }

  // ==========================================
  // Adjustment API
  // ==========================================

  setAdjustment<K extends keyof ChannelAdjustments>(
    channel: Channel, key: K, value: ChannelAdjustments[K]
  ): void {
    this.state[channel][key] = value;
    this.scheduleRender();
  }

  setCurve(channel: Channel, curve: CurvePoints): void {
    this.state[channel].curve = curve;
    this.scheduleRender();
  }

  resetChannel(channel: Channel): void {
    this.state[channel] = makeIdentityAdjustments();
    this.scheduleRender();
  }

  resetAll(): void {
    this.state = makeIdentityState();
    this.scheduleRender();
  }

  // ==========================================
  // Auto operations
  // ==========================================

  /**
   * Auto-stretch each channel independently to [loPct, hiPct] percentile
   * range. Affects brightness/contrast sliders; curves untouched.
   */
  autoStretch(loPct = 0.05, hiPct = 0.95): void {
    const hist = this.histogram$.value;
    if (!hist) return;
    for (const ch of ['r', 'g', 'b'] as const) {
      const adj = autoStretchAdjustment(hist[ch], hist.total, loPct, hiPct);
      this.state[ch].brightness = adj.brightness;
      this.state[ch].contrast = adj.contrast;
    }
    this.scheduleRender();
  }

  /**
   * Histogram equalization via luma curve. Per-channel adjustments untouched.
   */
  equalize(): void {
    const hist = this.histogram$.value;
    if (!hist) return;
    this.state.luma.curve = equalizeCurve(hist.luma, hist.total);
    this.scheduleRender();
  }

  // ==========================================
  // Internal
  // ==========================================

  private scheduleRender(): void {
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;
    queueMicrotask(() => this.runRender());
  }

  private async runRender(): Promise<void> {
    try {
      if (!this.sourceCanvas) return;

      if (isIdentity(this.state) || !this.editorService.useProcessing) {
        this.output$.next(this.sourceCanvas);
        this.editorService.requestCanvasRedraw();
        return;
      }

      const lut: RGBLUT = composeRGBLUT(this.state);
      const out = await this.renderer.render(this.sourceCanvas, lut);
      this.output$.next(out);
      this.editorService.requestCanvasRedraw();
    } finally {
      this.rendering = false;
      if (this.renderQueued) {
        this.renderQueued = false;
        this.scheduleRender();
      }
    }
  }

  private recomputeHistogram(): void {
    if (!this.sourceCanvas) return;
    const ctx = this.sourceCanvas.getContext('2d', { willReadFrequently: true })!;
    const img = ctx.getImageData(0, 0, this.sourceCanvas.width, this.sourceCanvas.height);
    this.histogram$.next(computeHistogram(img));
  }
}