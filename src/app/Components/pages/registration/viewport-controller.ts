// viewport-controller.ts

import { signal, computed } from '@angular/core';
import { PyramidLevel } from '../../../Services/pyramid.service';

// ==========================================
// Types
// ==========================================

export interface ViewTransform {
  /** CSS px per native image px. */
  scale:  number;
  /** Image origin in viewport CSS px. */
  offset: { x: number; y: number };
}

export interface ViewportSize {
  width:  number;
  height: number;
}


export class ViewportController {
  // ── Signals ────────────────────────────────────────────────────────────────
  private _scale  = signal(1);
  private _offset = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  private _size   = signal<ViewportSize>({ width: 0, height: 0 });

  /** Current view transform, reactive. */
  readonly transform = computed<ViewTransform>(() => ({
    scale:  this._scale(),
    offset: this._offset(),
  }));

  readonly scale  = computed(() => this._scale());
  readonly offset = computed(() => this._offset());
  readonly size   = computed(() => this._size());

  // ── Zoom limits ────────────────────────────────────────────────────────────
  readonly minScale = 0.05;
  readonly maxScale = 64;

  
  smooth = true;

  // ── Animation ──────────────────────────────────────────────────────────────
  private targetScale  = 1;
  private targetOffset = { x: 0, y: 0 };
  private rafId?: number;

  // ── Pan state ──────────────────────────────────────────────────────────────
  public isDragging = false;
  private prevClient: { x: number; y: number } | null = null;

  // ── Callbacks (set by SyncGroup) ───────────────────────────────────────────
  /** Called whenever this controller's transform changes. */
  onTransformChange?: (t: ViewTransform) => void;
  /** Redraws the canvas. Set by the component. */
  onRedrawNeeded?: () => void;

  // ==========================================
  // Setup
  // ==========================================

  setSize(width: number, height: number): void {
    this._size.set({ width, height });
  }
  setScale(val: number) {
    this._scale.set(val);
    this.onRedrawNeeded?.(); // You can even trigger redraws automatically here
  }

  setOffset(val: {x: number, y: number}) {
    this._offset.set(val);
    this.onRedrawNeeded?.();
  }

  // ==========================================
  // Coordinate conversions
  // ==========================================

  viewportToNative(vp: { x: number; y: number }): { x: number; y: number } {
    const s = this._scale(), o = this._offset();
    return {
      x: (vp.x - o.x) / s,
      y: (vp.y - o.y) / s,
    };
  }

  nativeToViewport(p: { x: number; y: number }): { x: number; y: number } {
    const s = this._scale(), o = this._offset();
    return { x: p.x * s + o.x, y: p.y * s + o.y };
  }

  clientToViewport(
    clientX: number, clientY: number,
    rect: DOMRect,
  ): { x: number; y: number } {
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  clientToNative(
    clientX: number, clientY: number,
    rect: DOMRect,
  ): { x: number; y: number } {
    const vp = this.clientToViewport(clientX, clientY, rect);
    return this.viewportToNative(vp);
  }

 
  applyToContext(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dpr: number,
  ): void {
    const s = this._scale(), o = this._offset();
    ctx.setTransform(s * dpr, 0, 0, s * dpr, Math.round(o.x * dpr), Math.round(o.y * dpr));
  }

  /**
   * Adjusted transform when drawing from a pyramid level instead of native.
   * The canvas is `level.scale` smaller, so the effective zoom is divided.
   */
  applyToContextForLevel(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dpr: number,
    level: PyramidLevel,
  ): void {
    const s = this._scale(), o = this._offset();
    const lvlScale = s / level.scale;
    ctx.setTransform(
      lvlScale * dpr, 0,
      0, lvlScale * dpr,
      Math.round(o.x * dpr), Math.round(o.y * dpr),
    );
  }

  // ==========================================
  // Pan
  // ==========================================

  startDrag(clientX: number, clientY: number): void {
    this.isDragging = true;
    this.prevClient = { x: clientX, y: clientY };
  }

  drag(clientX: number, clientY: number): void {
    if (!this.isDragging || !this.prevClient) return;
    const dx = clientX - this.prevClient.x;
    const dy = clientY - this.prevClient.y;
    this.prevClient = { x: clientX, y: clientY };
    const o = this._offset();
    this.setTransformImmediate(this._scale(), { x: o.x + dx, y: o.y + dy });
  }

  endDrag(): void {
    this.isDragging = false;
    this.prevClient = null;
  }

  // ==========================================
  // Zoom
  // ==========================================

  wheel(event: WheelEvent, rect: DOMRect): void {
    event.preventDefault();
    const dir = event.deltaY < 0 ? 1 : -1;
    const factor = Math.exp(dir * 0.25);
    const pivot = this.clientToViewport(event.clientX, event.clientY, rect);
    this.zoomAt(pivot, factor);
  }

  zoomAt(pivotViewport: { x: number; y: number }, factor: number): void {
    const pivotNative = this.viewportToNative(pivotViewport);
    let ns = Math.min(this.maxScale, Math.max(this.minScale, this.targetScale * factor));
    const no = {
      x: pivotViewport.x - pivotNative.x * ns,
      y: pivotViewport.y - pivotNative.y * ns,
    };
    this.targetScale  = ns;
    this.targetOffset = no;
    if (this.smooth) {
      this.scheduleSmooth();
    } else {
      this.setTransformImmediate(ns, no);
    }
  }

  zoomIn(factor = 1.25):  void { this.zoomAt(this.viewportCenter(), factor); }
  zoomOut(factor = 1.25): void { this.zoomAt(this.viewportCenter(), 1 / factor); }

  // ==========================================
  // Fit / reset
  // ==========================================

  /**
   * Fit the image (nativeW × nativeH) inside the current viewport.
   * Centers it with a small margin.
   */
  fitImage(nativeW: number, nativeH: number, smooth = true): void {
    const { width, height } = this._size();
    if (width === 0 || height === 0 || nativeW === 0 || nativeH === 0) return;

    const margin = 24; // CSS px
    const fit = Math.min(
      (width  - margin * 2) / nativeW,
      (height - margin * 2) / nativeH,
    );
    const s = Math.min(this.maxScale, Math.max(this.minScale, fit));
    const o = {
      x: (width  - nativeW * s) / 2,
      y: (height - nativeH * s) / 2,
    };
    this.targetScale  = s;
    this.targetOffset = o;
    if (smooth && this.smooth) {
      this.scheduleSmooth();
    } else {
      this.setTransformImmediate(s, o);
    }
  }

  reset(nativeW: number, nativeH: number): void {
    this.fitImage(nativeW, nativeH, false);
  }

  // ==========================================
  // External set (used by SyncGroup)
  // ==========================================

  setTransformExternal(t: ViewTransform): void {
    // Skip the onTransformChange callback to avoid re-broadcast from the
    // recipient back to the group.
    this._scale.set(t.scale);
    this._offset.set({ ...t.offset });
    this.targetScale  = t.scale;
    this.targetOffset = { ...t.offset };
    this.onRedrawNeeded?.();
  }

  // ==========================================
  // Viewbox (for SVG overlay sync)
  // ==========================================

  /**
   * SVG viewBox in native image space, covering exactly the visible viewport.
   * Pass directly to SVGElement.setAttribute('viewBox', ...).
   */
  getSVGViewBox(nativeW: number, nativeH: number): string {
    const s = this._scale(), o = this._offset();
    if (s <= 0) return `0 0 ${nativeW} ${nativeH}`;
    const { width, height } = this._size();
    const x = -o.x / s;
    const y = -o.y / s;
    const w = width  / s;
    const h = height / s;
    return `${x} ${y} ${w} ${h}`;
  }

  // ==========================================
  // Internal
  // ==========================================

  private setTransformImmediate(s: number, o: { x: number; y: number }): void {
    this._scale.set(s);
    this._offset.set({ ...o });
    this.onTransformChange?.({ scale: s, offset: { ...o } });
    this.onRedrawNeeded?.();
  }

  private viewportCenter(): { x: number; y: number } {
    const { width, height } = this._size();
    return { x: width / 2, y: height / 2 };
  }

  private scheduleSmooth(): void {
    if (this.rafId !== undefined) return;
    this.rafId = requestAnimationFrame(() => this.smoothStep());
  }

  private smoothStep(): void {
    this.rafId = undefined;
    const ease = 0.3;
    const s  = this._scale();
    const o  = this._offset();
    const ns = s  + (this.targetScale    - s)    * ease;
    const nx = o.x + (this.targetOffset.x - o.x) * ease;
    const ny = o.y + (this.targetOffset.y - o.y) * ease;

    const dS = Math.abs(this.targetScale    - ns);
    const dx = Math.abs(this.targetOffset.x - nx);
    const dy = Math.abs(this.targetOffset.y - ny);

    if (dS > 0.001 || dx > 0.5 || dy > 0.5) {
      this._scale.set(ns);
      this._offset.set({ x: nx, y: ny });
      this.onTransformChange?.({ scale: ns, offset: { x: nx, y: ny } });
      this.onRedrawNeeded?.();
      this.rafId = requestAnimationFrame(() => this.smoothStep());
    } else {
      this.setTransformImmediate(this.targetScale, this.targetOffset);
    }
  }

  destroy(): void {
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
  }
}

export class SyncGroup {
  private controllers: ViewportController[] = [];
  private active = true;
  private broadcasting = false; // re-entrancy guard

  add(vc: ViewportController): void {
    if (this.controllers.includes(vc)) return;
    this.controllers.push(vc);
    vc.onTransformChange = (t) => this.broadcast(vc, t);
  }

  remove(vc: ViewportController): void {
    this.controllers = this.controllers.filter(c => c !== vc);
    vc.onTransformChange = undefined;
  }

  pause():  void { this.active = false; }
  resume(): void { this.active = true;  }
  toggle(): void { this.active = !this.active; }
  get isSynced(): boolean { return this.active; }

  /**
   * Broadcast a transform change from `source` to all other controllers.
   * The re-entrancy guard prevents ping-pong: when controller A's change
   * updates B, B's setTransformExternal call must not trigger B→A again.
   */
  private broadcast(source: ViewportController, t: ViewTransform): void {
    if (!this.active || this.broadcasting) return;
    this.broadcasting = true;
    try {
      for (const vc of this.controllers) {
        if (vc !== source) vc.setTransformExternal(t);
      }
    } finally {
      this.broadcasting = false;
    }
  }

  /**
   * Align all controllers to the given controller's current transform.
   * Useful when resuming sync after operating independently.
   */
  alignTo(source: ViewportController): void {
    const t = source.transform();
    for (const vc of this.controllers) {
      if (vc !== source) vc.setTransformExternal(t);
    }
  }

  destroy(): void {
    for (const vc of this.controllers) {
      vc.onTransformChange = undefined;
    }
    this.controllers = [];
  }
}