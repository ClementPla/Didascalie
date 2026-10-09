import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { api, Frame } from '../../../lib/api';
import { SequenceService } from '../../../services/sequence.service';
import { ViewportController } from '../../registration/viewport-controller';
import { OverlayLabel, SequenceFrameCache } from '../frame-cache';

/**
 * Where a pane is looking, independently of its size and of its image's: how
 * far it is zoomed past "fit", and which point of the image (0..1 on each
 * axis) sits at its centre. This is what panes exchange to stay in step, so
 * two sequences of different resolutions still show the same region.
 */
export interface RelativeView {
  zoom: number;
  cx: number;
  cy: number;
}

type PaneStatus = 'loading' | 'ready' | 'error';

/** Preview sizes requested from the backend (longest side, px). A few fixed
 *  steps rather than the exact pane size, so resizing the window does not
 *  throw the cache away at every pixel. */
const PREVIEW_STEPS = [512, 768, 1024, 1536, 2048];
/** Margin `ViewportController.fitImage` leaves around a fitted image (CSS px). */
const FIT_MARGIN = 24;

/**
 * One sequence in the inspector: a read-only view of its frames with their
 * labels on top, following a frame index it is given.
 *
 * It owns the sequence's frame cache and its own zoom/pan, and knows nothing
 * about playback — the panel drives every pane from one clock, and asks each
 * whether a frame `isReady` before moving on to it.
 */
@Component({
  selector: 'app-inspect-pane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonModule, TooltipModule],
  templateUrl: './inspect-pane.component.html',
  styleUrl: './inspect-pane.component.scss',
})
export class InspectPaneComponent implements AfterViewInit, OnDestroy {
  private readonly sequences = inject(SequenceService);
  private readonly zone = inject(NgZone);

  readonly sequenceId = input.required<number>();
  /** The panel's frame index. Past this sequence's end, the last frame holds. */
  readonly frameIndex = input(0);
  readonly opacity = input(0.5);
  /** The labels to draw, bottom to top. */
  readonly labels = input<OverlayLabel[]>([]);
  /** Outline the labelled regions instead of filling them. */
  readonly edgesOnly = input(false);
  /** Decoded bytes this pane's frame cache may hold. */
  readonly budget = input(128 * 1024 ** 2);
  readonly loop = input(true);
  /** The panel's frames playback is limited to (first and last, included);
   *  null for the whole sequence. Only those are buffered. */
  readonly range = input<readonly [number, number] | null>(null);
  readonly focused = input(false);
  readonly closable = input(false);

  readonly focusRequested = output<void>();
  readonly closeRequested = output<void>();
  /** Open this sequence in the editor, on the given frame index. */
  readonly editRequested = output<number>();
  /** The user zoomed or panned this pane. */
  readonly viewChanged = output<RelativeView>();

  readonly hostEl = viewChild.required<ElementRef<HTMLDivElement>>('host');
  readonly canvasEl =
    viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  readonly frames = signal<Frame[]>([]);
  readonly frameCount = computed(() => this.frames().length);
  readonly status = signal<PaneStatus>('loading');
  /** The frame to show is still being fetched. */
  readonly waiting = signal(false);

  /** This sequence's frame for the panel's index. */
  readonly localIndex = computed(() =>
    Math.max(0, Math.min(this.frameIndex(), this.frameCount() - 1)),
  );

  readonly name = computed(() => {
    const id = this.sequenceId();
    return (
      this.sequences.sequences().find((s) => s.id === id)?.name ??
      `Sequence ${id}`
    );
  });

  readonly controller = new ViewportController();

  private readonly viewSize = signal({ width: 0, height: 0 });
  /** Longest side of the previews to request, 0 until the pane is laid out. */
  private readonly previewDim = computed(() => {
    const { width, height } = this.viewSize();
    const first = this.frames()[0];
    if (!first || width === 0 || height === 0) return 0;
    // What the fitted image covers on screen, in device pixels.
    const fit = Math.min(width / first.width, height / first.height);
    const needed = Math.max(first.width, first.height) * fit * this.dpr;
    return (
      PREVIEW_STEPS.find((step) => step >= needed) ??
      PREVIEW_STEPS[PREVIEW_STEPS.length - 1]
    );
  });

  private cache: SequenceFrameCache | null = null;
  /** The labels and style the current cache was built or updated with. */
  private cacheLabels: OverlayLabel[] | null = null;
  private cacheEdgesOnly = false;
  /** The frame on the canvas, which may lag behind `localIndex`. */
  private shownIndex: number | null = null;
  private loadToken = 0;

  private readonly dpr = Math.max(1, window.devicePixelRatio || 1);
  private resizeObserver?: ResizeObserver;
  /** The user chose a view: stop refitting the image when the pane resizes. */
  private userMoved = false;
  /** Set while this pane moves its own view for a reason that is not the
   *  user's (fitting, following another pane), so it is not echoed back. */
  private silent = false;
  private readonly removeListeners: (() => void)[] = [];
  /** The canvas exists. Effects first run before the view is created. */
  private viewReady = false;

  constructor() {
    effect(() => {
      const id = this.sequenceId();
      untracked(() => void this.loadSequence(id));
    });

    // A new sequence, or a pane resized past a preview step: start over.
    effect(() => {
      const frames = this.frames();
      const maxDim = this.previewDim();
      untracked(() => this.rebuildCache(frames, maxDim));
    });

    effect(() => {
      const labels = this.labels();
      const edgesOnly = this.edgesOnly();
      untracked(() => {
        if (!this.cache) return;
        if (labels === this.cacheLabels && edgesOnly === this.cacheEdgesOnly) {
          return;
        }
        this.cacheLabels = labels;
        this.cacheEdgesOnly = edgesOnly;
        this.cache.setOverlay(labels, edgesOnly);
        this.draw();
      });
    });

    effect(() => {
      const budget = this.budget();
      untracked(() => this.cache?.setBudget(budget));
    });

    effect(() => {
      const loop = this.loop();
      untracked(() => this.cache?.setLoop(loop));
    });

    effect(() => {
      const range = this.range();
      untracked(() => this.applyRange(range));
    });

    effect(() => {
      const index = this.localIndex();
      untracked(() => {
        this.cache?.setPlayhead(index);
        this.draw();
      });
    });

    effect(() => {
      this.opacity();
      untracked(() => this.draw());
    });
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    this.controller.onRedrawNeeded = () => this.draw();
    this.controller.onTransformChange = () => {
      if (this.silent) return;
      const view = this.relativeView();
      if (view) this.viewChanged.emit(view);
    };

    const host = this.hostEl().nativeElement;
    // Pointer and wheel events fire continuously while panning; nothing they
    // do needs a change-detection pass, so keep them out of the zone.
    this.zone.runOutsideAngular(() => {
      this.resizeObserver = new ResizeObserver((entries) => {
        const { width, height } = entries[0].contentRect;
        this.resize(Math.round(width), Math.round(height));
      });
      this.resizeObserver.observe(host);

      this.listen(host, 'wheel', (e) => this.onWheel(e), { passive: false });
      this.listen(host, 'pointerdown', (e) => this.onPointerDown(e));
      this.listen(host, 'pointermove', (e) => this.onPointerMove(e));
      this.listen(host, 'pointerup', (e) => this.onPointerUp(e));
      this.listen(host, 'pointercancel', (e) => this.onPointerUp(e));
      this.listen(host, 'dblclick', (e) => {
        if (!isControl(e.target)) this.fit(true);
      });
    });
  }

  ngOnDestroy(): void {
    this.viewReady = false;
    this.loadToken++;
    this.resizeObserver?.disconnect();
    for (const remove of this.removeListeners) remove();
    this.controller.onRedrawNeeded = undefined;
    this.controller.onTransformChange = undefined;
    this.controller.destroy();
    this.cache?.dispose();
    this.cache = null;
  }

  // ── Driven by the panel ──────────────────────────────────────────────────

  /**
   * Whether the panel may move on to its frame `index`: this pane has it
   * decoded, or will never have it (a sequence or a frame that failed to
   * load must not hold the others back).
   */
  isReady(index: number): boolean {
    if (this.status() === 'error') return true;
    if (!this.cache) return false;
    const local = Math.max(0, Math.min(index, this.frameCount() - 1));
    return this.cache.isReady(local);
  }

  /** This pane's view, or null before it has an image and a size. */
  relativeView(): RelativeView | null {
    const native = this.nativeSize();
    const fit = this.fitScale();
    if (!native || fit === 0) return null;
    const { width, height } = this.viewSize();
    const scale = this.controller.scale();
    const offset = this.controller.offset();
    return {
      zoom: scale / fit,
      cx: (width / 2 - offset.x) / scale / native.width,
      cy: (height / 2 - offset.y) / scale / native.height,
    };
  }

  /** Look where another pane is looking. */
  applyRelativeView(view: RelativeView): void {
    const native = this.nativeSize();
    const fit = this.fitScale();
    if (!native || fit === 0) return;
    const { width, height } = this.viewSize();
    const scale = view.zoom * fit;
    this.userMoved = true;
    this.controller.setTransformExternal({
      scale,
      offset: {
        x: width / 2 - view.cx * native.width * scale,
        y: height / 2 - view.cy * native.height * scale,
      },
    });
  }

  /**
   * Fit the image in the pane. `byUser` when asked for explicitly: the other
   * panes then follow, as they would any other change of view.
   */
  fit(byUser = false): void {
    const native = this.nativeSize();
    if (!native) return;
    this.userMoved = false;
    this.silent = true;
    this.controller.fitImage(native.width, native.height, false);
    this.silent = false;
    if (byUser) {
      const view = this.relativeView();
      if (view) this.viewChanged.emit(view);
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  private async loadSequence(id: number): Promise<void> {
    const token = ++this.loadToken;
    this.status.set('loading');
    this.shownIndex = null;
    this.userMoved = false;
    this.frames.set([]);
    this.clearCanvas();

    try {
      const frames = await api.getSequenceFrames(id);
      if (token !== this.loadToken) return;
      this.frames.set(frames);
      this.status.set(frames.length > 0 ? 'ready' : 'error');
    } catch (error) {
      if (token !== this.loadToken) return;
      console.error(`Failed to load sequence ${id} for inspection:`, error);
      this.status.set('error');
    }
  }

  private applyRange(range: readonly [number, number] | null): void {
    // The cache clamps to this sequence's own length.
    this.cache?.setRange(range?.[0] ?? 0, range?.[1] ?? Number.MAX_SAFE_INTEGER);
  }

  private rebuildCache(frames: readonly Frame[], maxDim: number): void {
    this.cache?.dispose();
    this.cache = null;
    this.shownIndex = null;
    if (frames.length === 0 || maxDim === 0) return;

    this.cacheLabels = this.labels();
    this.cacheEdgesOnly = this.edgesOnly();
    const cache = new SequenceFrameCache(
      frames,
      maxDim,
      this.cacheLabels,
      this.cacheEdgesOnly,
      this.budget(),
      this.loop(),
    );
    cache.onFrameReady = (index) => {
      if (index === this.localIndex()) this.draw();
    };
    this.cache = cache;
    this.applyRange(this.range());
    if (!this.userMoved) this.fit();
    cache.setPlayhead(this.localIndex());
    this.draw();
  }

  // ── Drawing ──────────────────────────────────────────────────────────────

  private resize(width: number, height: number): void {
    if (width === 0 || height === 0) return;
    const current = this.viewSize();
    if (width === current.width && height === current.height) return;

    const canvas = this.canvasEl().nativeElement;
    canvas.width = Math.round(width * this.dpr);
    canvas.height = Math.round(height * this.dpr);
    this.controller.setSize(width, height);
    this.viewSize.set({ width, height });
    if (!this.userMoved) this.fit();
    this.draw();
  }

  private draw(): void {
    const cache = this.cache;
    const index = this.localIndex();
    this.waiting.set(!!cache && !cache.isReady(index));
    if (!cache || !this.viewReady) return;

    // Until the wanted frame arrives, the previous one stays up: a late frame
    // should read as a held image, not as a flash of empty canvas.
    const shown = cache.get(index) ? index : this.shownIndex;
    const frame = shown === null ? undefined : cache.get(shown);
    const meta = shown === null ? undefined : this.frames()[shown];
    if (!frame || !meta || shown === null) return;
    this.shownIndex = shown;
    cache.pin(shown);

    const canvas = this.canvasEl().nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    this.controller.applyToContext(ctx, this.dpr);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(frame.image, 0, 0, meta.width, meta.height);

    const opacity = this.opacity();
    if (frame.overlay && opacity > 0) {
      // Magnified, labels keep hard pixel edges, as in the editor; shrunk,
      // smoothing avoids thin structures breaking up.
      const magnification =
        (this.controller.scale() * this.dpr * meta.width) / frame.overlay.width;
      ctx.imageSmoothingEnabled = magnification < 1;
      ctx.globalAlpha = opacity;
      ctx.drawImage(frame.overlay, 0, 0, meta.width, meta.height);
      ctx.globalAlpha = 1;
    }
  }

  private clearCanvas(): void {
    if (!this.viewReady) return;
    const canvas = this.canvasEl().nativeElement;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** Size of the image the view is laid out against (the frames of a
   *  sequence normally share one). */
  private nativeSize(): { width: number; height: number } | null {
    const frame = this.frames()[this.shownIndex ?? 0] ?? this.frames()[0];
    return frame ? { width: frame.width, height: frame.height } : null;
  }

  /** The scale `fit()` gives the image; 0 when it cannot be laid out yet. */
  private fitScale(): number {
    const native = this.nativeSize();
    const { width, height } = this.viewSize();
    if (!native || width === 0 || height === 0) return 0;
    const fit = Math.min(
      (width - FIT_MARGIN * 2) / native.width,
      (height - FIT_MARGIN * 2) / native.height,
    );
    return Math.min(
      this.controller.maxScale,
      Math.max(this.controller.minScale, fit),
    );
  }

  // ── Input ────────────────────────────────────────────────────────────────

  private onWheel(event: WheelEvent): void {
    if (isControl(event.target)) return;
    this.userMoved = true;
    this.controller.wheel(
      event,
      this.hostEl().nativeElement.getBoundingClientRect(),
    );
  }

  private onPointerDown(event: PointerEvent): void {
    if (isControl(event.target)) return;
    if (!this.focused()) this.focusRequested.emit();
    if (event.button !== 0 && event.button !== 1) return;
    this.hostEl().nativeElement.setPointerCapture(event.pointerId);
    this.controller.startDrag(event.clientX, event.clientY);
  }

  private onPointerMove(event: PointerEvent): void {
    if (!this.controller.isDragging) return;
    this.userMoved = true;
    this.controller.drag(event.clientX, event.clientY);
  }

  private onPointerUp(event: PointerEvent): void {
    if (!this.controller.isDragging) return;
    this.controller.endDrag();
    const host = this.hostEl().nativeElement;
    if (host.hasPointerCapture(event.pointerId)) {
      host.releasePointerCapture(event.pointerId);
    }
  }

  private listen<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, handler, options);
    this.removeListeners.push(() =>
      target.removeEventListener(type, handler, options),
    );
  }
}

/** The event started on one of the pane's buttons, not on the image. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button') !== null;
}
