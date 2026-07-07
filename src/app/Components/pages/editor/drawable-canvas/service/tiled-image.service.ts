import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { api } from '../../../../../lib/api';

/** A native tile ready to draw, positioned at (x, y) in image space. */
export interface ReadyTile {
  x: number;
  y: number;
  bitmap: ImageBitmap;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Serves native-resolution image tiles for the zoomed-in region of very large
 * images (whose full bitmap the browser can't decode). Tiles are fetched from
 * Rust (`get_frame_tile`), decoded to `ImageBitmap`s and cached (LRU). The
 * editor draws them over the downsampled overview backdrop, so detail sharpens
 * where you're looking. Tiles are only fetched when zoomed in enough that the
 * visible region spans few tiles — zoomed out, the overview is enough.
 */
@Injectable({ providedIn: 'root' })
export class TiledImageService {
  private static readonly TILE = 1024;
  /** Above this many visible tiles we're too zoomed out — skip, use overview. */
  private static readonly MAX_VISIBLE = 24;
  private static readonly MAX_CACHE = 64;

  /** Emits when a requested tile finishes loading, so the view can redraw. */
  readonly tileLoaded$ = new Subject<void>();

  private frameId: number | null = null;
  private nativeW = 0;
  private nativeH = 0;

  private readonly cache = new Map<string, ImageBitmap>();
  private readonly order: string[] = []; // LRU key order (oldest first)
  private readonly inflight = new Set<string>();

  /** Point at a frame's native pixels. Clears tiles when the frame changes. */
  setFrame(frameId: number, nativeW: number, nativeH: number): void {
    if (this.frameId === frameId && this.nativeW === nativeW && this.nativeH === nativeH) {
      return;
    }
    this.clear();
    this.frameId = frameId;
    this.nativeW = nativeW;
    this.nativeH = nativeH;
  }

  clear(): void {
    for (const bm of this.cache.values()) bm.close();
    this.cache.clear();
    this.order.length = 0;
    this.inflight.clear();
    this.frameId = null;
  }

  /**
   * Ready native tiles covering the image-space `rect`, fetching any missing
   * visible ones in the background. Returns [] when too zoomed out to bother.
   */
  tilesFor(rect: Rect, frameId: number): ReadyTile[] {
    if (this.frameId !== frameId || this.nativeW === 0) return [];

    const TS = TiledImageService.TILE;
    const c0 = Math.max(0, Math.floor(rect.x / TS));
    const r0 = Math.max(0, Math.floor(rect.y / TS));
    const c1 = Math.min(Math.ceil(this.nativeW / TS) - 1, Math.floor((rect.x + rect.width) / TS));
    const r1 = Math.min(Math.ceil(this.nativeH / TS) - 1, Math.floor((rect.y + rect.height) / TS));
    if (c1 < c0 || r1 < r0) return [];
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > TiledImageService.MAX_VISIBLE) return [];

    const ready: ReadyTile[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = `${c},${r}`;
        const bm = this.cache.get(key);
        if (bm) {
          this.touch(key);
          ready.push({ x: c * TS, y: r * TS, bitmap: bm });
        } else {
          this.fetch(c, r, frameId);
        }
      }
    }
    return ready;
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
