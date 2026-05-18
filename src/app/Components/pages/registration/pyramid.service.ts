// pyramid.service.ts

import { Injectable, OnDestroy } from '@angular/core';

// ==========================================
// Types
// ==========================================

/**
 * One level of a resolution pyramid.
 * `scale` = levelPx / nativePx, so a point in native image space
 * multiplied by `scale` gives its position in this level's canvas.
 */
export interface PyramidLevel {
  canvas: OffscreenCanvas;
  width:  number;
  height: number;
  /** levelPx / nativePx. Level 0 (native) is 1.0; each step halves it. */
  scale:  number;
  /** Human label for debugging: "L0 (6000×4000)", "L1 (3000×2000)", … */
  label:  string;
}

export interface Pyramid {
  /** Levels from finest (index 0 = native) to coarsest. */
  levels:        PyramidLevel[];
  nativeWidth:   number;
  nativeHeight:  number;
}

// ==========================================
// Configuration
// ==========================================

const MAX_LEVEL_PX       = 4096;  // coarsest level's longest side
const OVERSAMPLE_FACTOR  = 1.5;   // prefer a level at least 1.5× the viewport
const MAX_LEVELS         = 8;

// ==========================================
// Service
// ==========================================

@Injectable({ providedIn: 'root' })
export class PyramidService implements OnDestroy {
  /**
   * Cache: image src → Pyramid.  Lets multiple components access the same
   * image without re-building the pyramid. Cleared on destroy.
   */
  private cache = new Map<string, Promise<Pyramid>>();

  ngOnDestroy(): void {
    this.cache.clear();
  }

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Build (or return cached) pyramid for `img`.
   * Building is async because OffscreenCanvas drawImage is microtask-queued.
   * The caller should await once and then use `getLevelForViewport` sync.
   */
  async getPyramid(img: HTMLImageElement): Promise<Pyramid> {
    const key = img.src;
    if (!this.cache.has(key)) {
      this.cache.set(key, this.buildPyramid(img));
    }
    return this.cache.get(key)!;
  }

  /**
   * Invalidate the cache entry for a given image src.
   * Call if the image data changes underneath.
   */
  invalidate(src: string): void {
    this.cache.delete(src);
  }

  /**
   * Choose the best pyramid level for the given viewport size and current
   * view scale.
   *
   * We want a level whose pixel dimensions are ≥ (viewport × OVERSAMPLE)
   * at the current viewScale, so the rendered image doesn't look blocky.
   * Concretely, we want the *finest* level L where
   *
   *   L.width  × viewScale ≥ viewportWidth  × OVERSAMPLE
   *   L.height × viewScale ≥ viewportHeight × OVERSAMPLE
   *
   * If no level satisfies this, we return the finest (native) level.
   *
   * All inputs and outputs are in **native image-space coordinates**.
   * The caller still applies the view transform (scale + offset) from
   * ZoomPanService (or ViewportController); this just picks the texture.
   *
   * @param pyramid       The pyramid returned by getPyramid.
   * @param viewScale     CSS px per native image px (from the view transform).
   * @param viewportW     Viewport width in CSS px.
   * @param viewportH     Viewport height in CSS px.
   */
  getLevelForViewport(
    pyramid:   Pyramid,
    viewScale: number,
    viewportW: number,
    viewportH: number,
  ): PyramidLevel {
    const targetW = (viewportW * OVERSAMPLE_FACTOR) / viewScale;
    const targetH = (viewportH * OVERSAMPLE_FACTOR) / viewScale;

    // Walk from coarsest to finest; stop at the first level big enough.
    for (let i = pyramid.levels.length - 1; i >= 0; i--) {
      const lvl = pyramid.levels[i];
      if (lvl.width >= targetW && lvl.height >= targetH) {
        return lvl;
      }
    }
    return pyramid.levels[0]; // native
  }

  /**
   * Apply a level's scale to a native-space point for canvas drawing.
   * Use this when you want to position something in level-canvas coordinates.
   */
  nativeToLevel(p: { x: number; y: number }, level: PyramidLevel) {
    return { x: p.x * level.scale, y: p.y * level.scale };
  }

  /**
   * Convert a point from level-canvas coordinates back to native image space.
   */
  levelToNative(p: { x: number; y: number }, level: PyramidLevel) {
    return { x: p.x / level.scale, y: p.y / level.scale };
  }

  /**
   * Convenience: given a view transform (scale, offset) calibrated for the
   * native image, produce the equivalent transform for a specific level.
   * The level's canvas is smaller by `level.scale`, so we compensate.
   *
   * Returns { scale, offset } in the same shape as ViewportController exposes.
   *
   * Usage: when drawing a level canvas instead of the native image, call this
   * and apply the adjusted transform. Coordinate math stays in native space
   * everywhere else.
   */
  adjustTransformForLevel(
    nativeScale:  number,
    nativeOffset: { x: number; y: number },
    level:        PyramidLevel,
  ): { scale: number; offset: { x: number; y: number } } {
    // The level is `level.scale` smaller than native, so we need to zoom
    // the canvas by `nativeScale / level.scale` to make it look the same.
    return {
      scale:  nativeScale / level.scale,
      offset: nativeOffset, // offset stays in CSS px — level change doesn't shift origin
    };
  }

  // ==========================================
  // Build
  // ==========================================

  private async buildPyramid(img: HTMLImageElement): Promise<Pyramid> {
    const nativeWidth  = img.naturalWidth  || img.width;
    const nativeHeight = img.naturalHeight || img.height;

    if (nativeWidth === 0 || nativeHeight === 0) {
      throw new Error(`PyramidService: image has zero dimensions (src: ${img.src})`);
    }

    // Level 0: native resolution.
    const level0 = await this.makeLevel(img, nativeWidth, nativeHeight, 1.0, 'L0');
    const levels: PyramidLevel[] = [level0];

    let w = nativeWidth;
    let h = nativeHeight;
    let scale = 1.0;

    for (let i = 1; i < MAX_LEVELS; i++) {
      w = Math.floor(w / 2);
      h = Math.floor(h / 2);
      scale /= 2;

      if (w < 16 || h < 16) break;

      const label = `L${i} (${w}×${h})`;
      const lvl = await this.makeLevel(
        levels[i - 1].canvas,  // draw from previous level for better quality
        w, h, scale, label
      );
      levels.push(lvl);

      // Stop once the longest side is under our max.
      if (Math.max(w, h) <= MAX_LEVEL_PX) break;
    }

    return { levels, nativeWidth, nativeHeight };
  }

  private async makeLevel(
    source:  CanvasImageSource,
    width:   number,
    height:  number,
    scale:   number,
    label:   string,
  ): Promise<PyramidLevel> {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d', { alpha: false })!;

    // High-quality downsampling: `imageSmoothingQuality = 'high'` uses a
    // bicubic or lanczos-class filter in most browsers. We draw each level
    // from the *previous* level (halving step-by-step), which approximates
    // a box filter cascade and avoids aliasing better than direct downsampling.
    ctx.imageSmoothingEnabled  = true;
    ctx.imageSmoothingQuality  = 'high';
    ctx.drawImage(source, 0, 0, width, height);

    return { canvas, width, height, scale, label };
  }
}