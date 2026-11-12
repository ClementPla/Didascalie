import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

/** What the map needs of a frame. */
export interface FrameMapFrame {
  reviewed: boolean;
}

/**
 * A long sequence (a video) as one bar: a column per frame, or per group of
 * frames when there are more frames than pixels, filled where reviewed. The
 * current frame is marked. Drag or click to scrub; arrows, Page Up/Down and
 * Home/End from the keyboard.
 */
@Component({
  selector: 'app-frame-map',
  standalone: true,
  template: `
    <div
      #track
      class="frame-map"
      role="slider"
      tabindex="0"
      aria-label="Frame"
      [attr.aria-valuemin]="1"
      [attr.aria-valuemax]="frames().length"
      [attr.aria-valuenow]="current() + 1"
      [attr.aria-valuetext]="'Frame ' + (current() + 1) + ' of ' + frames().length"
      (pointerdown)="onPointerDown($event)"
      (pointermove)="onPointerMove($event)"
      (pointerup)="onPointerUp($event)"
      (pointercancel)="onPointerUp($event)"
      (pointerleave)="hover.set(null)"
      (keydown)="onKey($event)"
    >
      <canvas #canvas></canvas>
      @if (hover(); as h) {
        <span class="frame-map__label" [style.left.px]="h.x">{{ h.index + 1 }}</span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .frame-map {
      position: relative;
      height: 1.9rem;
      border-radius: 4px;
      cursor: pointer;
      touch-action: none;
      outline: none;
    }
    .frame-map:focus-visible {
      box-shadow: 0 0 0 2px var(--p-primary-color);
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
      border-radius: inherit;
    }
    .frame-map__label {
      position: absolute;
      bottom: calc(100% + 4px);
      transform: translateX(-50%);
      padding: 0.1rem 0.4rem;
      border-radius: 4px;
      background: var(--p-text-color);
      color: var(--p-content-background);
      font-size: 0.7rem;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      pointer-events: none;
    }
    @media (pointer: coarse) {
      .frame-map {
        height: 2.4rem;
      }
    }
  `,
})
export class FrameMapComponent implements AfterViewInit, OnDestroy {
  readonly frames = input.required<readonly FrameMapFrame[]>();
  /** Index of the current frame. */
  readonly current = input.required<number>();
  /** Frames to mark (what an action would write): those after the current
   *  one, or all but it. */
  readonly highlight = input<'following' | 'allOthers' | null>(null);
  /** A frame was picked; emitted on every move while dragging. */
  readonly frameSelected = output<number>();

  /** Frame under the pointer, and where to show its number. */
  readonly hover = signal<{ index: number; x: number } | null>(null);

  private readonly track = viewChild.required<ElementRef<HTMLDivElement>>('track');
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private resizeObserver?: ResizeObserver;
  private dragging = false;
  private lastEmitted = -1;

  constructor() {
    effect(() => {
      this.frames();
      this.current();
      this.highlight();
      this.draw();
    });
  }

  ngAfterViewInit(): void {
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(this.track().nativeElement);
    this.draw();
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  private draw(): void {
    const canvas = this.canvas?.()?.nativeElement;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const pxWidth = Math.round(width * dpr);
    const pxHeight = Math.round(height * dpr);
    if (canvas.width !== pxWidth || canvas.height !== pxHeight) {
      canvas.width = pxWidth;
      canvas.height = pxHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const style = getComputedStyle(this.track().nativeElement);
    const text = style.getPropertyValue('--p-text-color').trim() || '#334155';
    const primary = style.getPropertyValue('--p-primary-color').trim() || '#10b981';

    const frames = this.frames();
    const count = frames.length;
    ctx.clearRect(0, 0, pxWidth, pxHeight);

    // Track.
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = text;
    ctx.fillRect(0, 0, pxWidth, pxHeight);
    if (count === 0) {
      ctx.globalAlpha = 1;
      return;
    }

    // Reviewed frames: one column per device pixel, shaded by the share of
    // its frames that are reviewed.
    ctx.fillStyle = text;
    for (let x = 0; x < pxWidth; x++) {
      const first = Math.floor((x * count) / pxWidth);
      const last = Math.max(first + 1, Math.floor(((x + 1) * count) / pxWidth));
      let reviewed = 0;
      for (let i = first; i < last; i++) if (frames[i].reviewed) reviewed++;
      if (reviewed === 0) continue;
      ctx.globalAlpha = 0.6 * (reviewed / (last - first));
      ctx.fillRect(x, 0, 1, pxHeight);
    }

    // Marked frames.
    const highlight = this.highlight();
    if (highlight) {
      const at = Math.min(Math.max(this.current(), 0), count - 1);
      const after = Math.round(((at + 1) * pxWidth) / count);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = primary;
      ctx.fillRect(after, 0, pxWidth - after, pxHeight);
      if (highlight === 'allOthers') {
        ctx.fillRect(0, 0, Math.round((at * pxWidth) / count), pxHeight);
      }
    }

    // Current frame.
    const current = Math.min(Math.max(this.current(), 0), count - 1);
    const markerWidth = Math.max(2 * dpr, pxWidth / count);
    const markerX = Math.min(
      pxWidth - markerWidth,
      Math.max(0, ((current + 0.5) * pxWidth) / count - markerWidth / 2),
    );
    ctx.globalAlpha = 1;
    ctx.fillStyle = primary;
    ctx.fillRect(markerX, 0, markerWidth, pxHeight);
  }

  // ── Pointer and keyboard ─────────────────────────────────────────────────

  private indexAt(event: PointerEvent): { index: number; x: number } {
    const rect = this.track().nativeElement.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const count = this.frames().length;
    const index = Math.min(count - 1, Math.max(0, Math.floor((x / rect.width) * count)));
    return { index, x };
  }

  private pick(index: number): void {
    if (index === this.lastEmitted && this.dragging) return;
    this.lastEmitted = index;
    this.frameSelected.emit(index);
  }

  onPointerDown(event: PointerEvent): void {
    if (this.frames().length === 0) return;
    this.dragging = true;
    this.lastEmitted = -1;
    this.track().nativeElement.setPointerCapture(event.pointerId);
    const at = this.indexAt(event);
    this.hover.set(at);
    this.pick(at.index);
  }

  onPointerMove(event: PointerEvent): void {
    if (this.frames().length === 0) return;
    const at = this.indexAt(event);
    // Touch has no hover: the number shows only while dragging.
    if (this.dragging || event.pointerType === 'mouse') this.hover.set(at);
    if (this.dragging) this.pick(at.index);
  }

  onPointerUp(event: PointerEvent): void {
    this.dragging = false;
    if (event.pointerType !== 'mouse') this.hover.set(null);
  }

  onKey(event: KeyboardEvent): void {
    const count = this.frames().length;
    if (count === 0) return;
    const page = Math.max(10, Math.round(count / 20));
    const steps: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      PageUp: page,
      PageDown: -page,
    };
    let target: number | null = null;
    if (event.key in steps) target = this.current() + steps[event.key];
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = count - 1;
    if (target === null) return;
    // Arrows here move frames, not sequences (the editor's global shortcut).
    event.preventDefault();
    event.stopPropagation();
    this.frameSelected.emit(Math.min(count - 1, Math.max(0, target)));
  }
}
