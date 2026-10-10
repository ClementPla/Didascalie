import { Injectable, OnDestroy } from '@angular/core';
import { ProjectScoped } from '../core/project-scoped';

// ── Types ──────────────────────────────────────────────────────────────────

/** One level of a resolution pyramid. A native-space point times `scale` is
 *  its position in this level's canvas. */
export interface PyramidLevel {
  canvas: OffscreenCanvas;
  width:  number;
  height: number;
  /** levelPx / nativePx: 1.0 at level 0, halved at each step. */
  scale:  number;
  /** For debugging: "L0 (6000×4000)". */
  label:  string;
}

export interface Pyramid {
  /** From finest (index 0) to coarsest. */
  levels:        PyramidLevel[];
  nativeWidth:   number;
  nativeHeight:  number;
}

// ── Configuration ──────────────────────────────────────────────────────────

const MAX_LEVEL_PX       = 4096;  // coarsest level's longest side
const OVERSAMPLE_FACTOR  = 1.5;   // prefer a level at least 1.5× the viewport
const MAX_LEVELS         = 8;

// ── Service ────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class PyramidService implements OnDestroy, ProjectScoped {
  /** Image src → pyramid. */
  private cache = new Map<string, Promise<Pyramid>>();

  /** @see ProjectScoped */
  resetForProject(): void {
    this.cache.clear();
  }

  ngOnDestroy(): void {
    this.cache.clear();
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Build, or return from cache, the pyramid of `img`. */
  async getPyramid(img: HTMLImageElement): Promise<Pyramid> {
    const key = img.src;
    if (!this.cache.has(key)) {
      this.cache.set(key, this.buildPyramid(img));
    }
    return this.cache.get(key)!;
  }

  /** Build, or return from cache, a pyramid of any canvas source, under a
   *  caller-supplied `key`. The caller invalidates it when the pixels change. */
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

  invalidate(src: string): void {
    this.cache.delete(src);
  }

  /**
   * The level to draw for a viewport size and view scale: the coarsest one
   * whose size on screen is at least the viewport times OVERSAMPLE, or the
   * finest when none is. `viewScale` is CSS px per native image px.
   */
  getLevelForViewport(
    pyramid:   Pyramid,
    viewScale: number,
    viewportW: number,
    viewportH: number,
  ): PyramidLevel {
    const targetW = (viewportW * OVERSAMPLE_FACTOR) / viewScale;
    const targetH = (viewportH * OVERSAMPLE_FACTOR) / viewScale;

    for (let i = pyramid.levels.length - 1; i >= 0; i--) {
      const lvl = pyramid.levels[i];
      if (lvl.width >= targetW && lvl.height >= targetH) {
        return lvl;
      }
    }
    return pyramid.levels[0]; // finest available
  }

  /** Even the finest stored level is too coarse for the viewport: the caller
   *  draws the full-resolution source (pyramids built with `finestPx`). */
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

  nativeToLevel(p: { x: number; y: number }, level: PyramidLevel) {
    return { x: p.x * level.scale, y: p.y * level.scale };
  }

  levelToNative(p: { x: number; y: number }, level: PyramidLevel) {
    return { x: p.x / level.scale, y: p.y / level.scale };
  }

  /** The view transform for drawing a level's canvas instead of the native
   *  image: the canvas is `level.scale` smaller. */
  adjustTransformForLevel(
    nativeScale:  number,
    nativeOffset: { x: number; y: number },
    level:        PyramidLevel,
  ): { scale: number; offset: { x: number; y: number } } {
    return {
      scale:  nativeScale / level.scale,
      offset: nativeOffset, // offset stays in CSS px — level change doesn't shift origin
    };
  }

  // ── Build ────────────────────────────────────────────────────────────────

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

    // Memory-bounded mode: no native-resolution copy, only levels whose longest
    // side is ≤ finestPx, each downsampled from the source.
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

    // Default mode, with a native L0: halved step by step. Used by registration.
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

    // Each level is drawn from the previous one: halving step by step aliases
    // less than downsampling directly.
    ctx.imageSmoothingEnabled  = true;
    ctx.imageSmoothingQuality  = 'high';
    ctx.drawImage(source, 0, 0, width, height);

    return { canvas, width, height, scale, label };
  }
}