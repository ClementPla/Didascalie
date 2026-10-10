import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { api } from '../../../../lib/api';
import { RGBLUT } from './image-adjustment/image-processing.model';
import { ProjectScoped } from '../../../../core/project-scoped';

/** A native tile ready to draw, positioned at (x, y) in image space. */
export interface ReadyTile {
  x: number;
  y: number;
  bitmap: CanvasImageSource;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Native-resolution tiles for the zoomed-in region of very large images.
 * Tiles are fetched from Rust (`get_frame_tile`), decoded to `ImageBitmap`s
 * and cached (LRU), and drawn over the downsampled backdrop. Only when zoomed
 * in enough that the visible region spans few tiles.
 */
@Injectable({ providedIn: 'root' })
export class TiledImageService implements ProjectScoped {
  private static readonly TILE = 1024;
  /** Above this many visible tiles, the backdrop is enough. */
  private static readonly MAX_VISIBLE = 24;
  private static readonly MAX_CACHE = 64;

  readonly tileLoaded$ = new Subject<void>();

  private frameId: number | null = null;
  private nativeW = 0;
  private nativeH = 0;

  private readonly cache = new Map<string, ImageBitmap>();
  private readonly order: string[] = []; // LRU key order (oldest first)
  private readonly inflight = new Set<string>();

  // Tiles with the image-adjustment LUT applied, for one adjustment version.
  private readonly processedCache = new Map<string, OffscreenCanvas>();
  private readonly processedOrder: string[] = [];
  private processedVersion = -1;

  setFrame(frameId: number, nativeW: number, nativeH: number): void {
    if (this.frameId === frameId && this.nativeW === nativeW && this.nativeH === nativeH) {
      return;
    }
    this.clear();
    this.frameId = frameId;
    this.nativeW = nativeW;
    this.nativeH = nativeH;
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.clear();
  }

  clear(): void {
    for (const bm of this.cache.values()) bm.close();
    this.cache.clear();
    this.order.length = 0;
    this.inflight.clear();
    this.clearProcessed();
    this.frameId = null;
  }

  /**
   * The ready native tiles covering the image-space `rect`; missing ones are
   * fetched in the background. Empty when too zoomed out. With `lut`, tiles
   * carry the image adjustments.
   */
  tilesFor(
    rect: Rect,
    frameId: number,
    lut: RGBLUT | null = null,
    version = 0,
  ): ReadyTile[] {
    if (this.frameId !== frameId || this.nativeW === 0) return [];

    const TS = TiledImageService.TILE;
    const c0 = Math.max(0, Math.floor(rect.x / TS));
    const r0 = Math.max(0, Math.floor(rect.y / TS));
    const c1 = Math.min(Math.ceil(this.nativeW / TS) - 1, Math.floor((rect.x + rect.width) / TS));
    const r1 = Math.min(Math.ceil(this.nativeH / TS) - 1, Math.floor((rect.y + rect.height) / TS));
    if (c1 < c0 || r1 < r0) return [];
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > TiledImageService.MAX_VISIBLE) return [];

    if (lut && version !== this.processedVersion) {
      this.clearProcessed();
      this.processedVersion = version;
    }

    const ready: ReadyTile[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = `${c},${r}`;
        const bm = this.cache.get(key);
        if (bm) {
          this.touch(key);
          const bitmap = lut ? this.processedTile(key, bm, lut) : bm;
          ready.push({ x: c * TS, y: r * TS, bitmap });
        } else {
          this.fetch(c, r, frameId);
        }
      }
    }
    return ready;
  }

  private processedTile(key: string, raw: ImageBitmap, lut: RGBLUT): OffscreenCanvas {
    const cached = this.processedCache.get(key);
    if (cached) {
      this.touchProcessed(key);
      return cached;
    }

    const canvas = new OffscreenCanvas(raw.width, raw.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(raw, 0, 0);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const d = image.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = lut.r[d[i]];
      d[i + 1] = lut.g[d[i + 1]];
      d[i + 2] = lut.b[d[i + 2]];
    }
    ctx.putImageData(image, 0, 0);

    this.processedCache.set(key, canvas);
    this.processedOrder.push(key);
    while (this.processedOrder.length > TiledImageService.MAX_CACHE) {
      const evict = this.processedOrder.shift();
      if (evict && evict !== key) this.processedCache.delete(evict);
    }
    return canvas;
  }

  private touchProcessed(key: string): void {
    const i = this.processedOrder.indexOf(key);
    if (i >= 0) {
      this.processedOrder.splice(i, 1);
      this.processedOrder.push(key);
    }
  }

  private clearProcessed(): void {
    this.processedCache.clear();
    this.processedOrder.length = 0;
    this.processedVersion = -1;
  }

  private fetch(col: number, row: number, frameId: number): void {
    const key = `${col},${row}`;
    if (this.inflight.has(key) || this.cache.has(key)) return;
    this.inflight.add(key);

    const TS = TiledImageService.TILE;
    const x = col * TS;
    const y = row * TS;
    const w = Math.min(TS, this.nativeW - x);
    const h = Math.min(TS, this.nativeH - y);
    if (w <= 0 || h <= 0) {
      this.inflight.delete(key);
      return;
    }

    api
      .getFrameTile(frameId, x, y, w, h)
      .then(async (buf) => {
        if (this.frameId !== frameId) return; // frame changed while loading
        const data = new Uint8ClampedArray(buf);
        const bitmap = await createImageBitmap(new ImageData(data, w, h));
        if (this.frameId !== frameId) {
          bitmap.close();
          return;
        }
        this.store(key, bitmap);
        this.tileLoaded$.next();
      })
      .catch((e) => console.error('[TiledImage] tile fetch failed:', e))
      .finally(() => this.inflight.delete(key));
  }

  private store(key: string, bitmap: ImageBitmap): void {
    this.cache.set(key, bitmap);
    this.order.push(key);
    while (this.order.length > TiledImageService.MAX_CACHE) {
      const evict = this.order.shift();
      if (evict && evict !== key) {
        this.cache.get(evict)?.close();
        this.cache.delete(evict);
      }
    }
  }

  private touch(key: string): void {
    const i = this.order.indexOf(key);
    if (i >= 0) {
      this.order.splice(i, 1);
      this.order.push(key);
    }
  }
}
