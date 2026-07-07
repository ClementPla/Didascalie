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
   * Build (or return cached) a pyramid from an arbitrary canvas source, keyed by
   * a caller-supplied `key`. Use when the source isn't an `<img>` with a stable
   * `src` — e.g. an adjusted `OffscreenCanvas` in the editor. The caller owns
   * invalidation: pass a new key (or call `invalidate`) when the pixels change.
   */
  async getPyramidForSource(
    source: CanvasImageSource,
    width: number,
    height: number,
    key: string,
    finestPx = 0,
  ): Promise<Pyramid> {
    if (!this.cache.has(key)) {
      this.cache.set(key, this.buildPyramidFromSource(source, width, height, finestPx));
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
    return pyramid.levels[0]; // finest available
  }

  /**
   * True when even the finest stored level is coarser than the viewport needs,
   * so the caller should draw the full-resolution *source* instead of a level.
   * Relevant for pyramids built via `getPyramidForSource(..., finestPx)`, which
   * omit a native-resolution level to save memory on very large images.
   */
  needsNativeResolution(
    pyramid: Pyramid,
    viewScale: number,
    viewportW: number,
    viewportH: number,
  ): boolean {
    const finest = pyramid.levels[0];
    if (!finest) return true;
    const targetW = (viewportW * OVERSAMPLE_FACTOR) / viewScale;
    const targetH = (viewportH * OVERSAMPLE_FACTOR) / viewScale;
    return finest.width < targetW || finest.height < targetH;
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
    return this.buildPyramidFromSource(img, nativeWidth, nativeHeight);
  }

  private async buildPyramidFromSource(
    source: CanvasImageSource,
    nativeWidth: number,
    nativeHeight: number,
    finestPx = 0,
  ): Promise<Pyramid> {
    if (nativeWidth === 0 || nativeHeight === 0) {
      throw new Error('PyramidService: source has zero dimensions');
    }

    // Memory-bounded mode: skip the native-resolution copy entirely (it can be
    // hundreds of MB on a large image) and store only levels whose longest side
    // is ≤ finestPx, each downsampled directly from the source. The caller draws
    // the source itself when it needs finer than the finest stored level (see
    // needsNativeResolution).
    if (finestPx > 0) {
      let w = nativeWidth;
      let h = nativeHeight;
      let scale = 1.0;
      while (Math.max(w, h) > finestPx && w >= 32 && h >= 32) {
        w = Math.floor(w / 2);
        h = Math.floor(h / 2);
        scale /= 2;
      }
      const levels: PyramidLevel[] = [];
      for (let i = 0; i < MAX_LEVELS && w >= 16 && h >= 16; i++) {
        levels.push(await this.makeLevel(source, w, h, scale, `L(${w}×${h})`));
        if (Math.max(w, h) <= 16) break;
        w = Math.floor(w / 2);
        h = Math.floor(h / 2);
        scale /= 2;
      }
      if (levels.length === 0) {
        levels.push(await this.makeLevel(source, nativeWidth, nativeHeight, 1.0, 'L0'));
      }
      return { levels, nativeWidth, nativeHeight };
    }

    // Default mode (includes a native L0): a step-by-step halving cascade for
    // best downsampling quality. Used by the registration viewers.
    const level0 = await this.makeLevel(source, nativeWidth, nativeHeight, 1.0, 'L0');
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