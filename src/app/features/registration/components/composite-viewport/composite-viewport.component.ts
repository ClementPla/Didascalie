import { TouchGesture } from '../../touch-gesture';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  computed,
  effect,
  inject,
  input,
  viewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { Pyramid, PyramidService } from '../../../../services/pyramid.service';
import { ViewportController } from '../../viewport-controller';
import {
  RegistrationStateService,
  colorForIndex,
} from '../../registration-state.service';
import {
  buildWarpedImageTransform,
  diagnoseHomography,
} from '../../render-warp';

@Component({
  selector: 'app-composite-viewport',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './composite-viewport.component.html',
  styleUrl: './composite-viewport.component.scss',
})
export class CompositeViewportComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  readonly refController = input.required<ViewportController>();
  readonly movingController = input.required<ViewportController>();
  readonly refPyramid = input<Pyramid | null>(null);
  readonly movingPyramid = input<Pyramid | null>(null);
  /** URL of the moving image, rendered through a CSS transform. */
  readonly movingImageUrl = input<string | null>(null);

  readonly hostEl = viewChild.required<ElementRef<HTMLDivElement>>('host');
  readonly canvasEl = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly svgEl = viewChild.required<ElementRef<SVGSVGElement>>('svg');

  private readonly state = inject(RegistrationStateService);
  private readonly pyramidSvc = inject(PyramidService);

  readonly warpStatus = computed<
    | { kind: 'ok' }
    | { kind: 'unwarped'; needed: number }
    | { kind: 'needs-pairs'; needed: number }
    | { kind: 'bad-fit'; reason: string }
    | { kind: 'no-image' }
  >(() => {
    const t = this.state.transform();
    if (t.type === 'identity') {
      const needed = Math.max(0, 4 - this.pairs().length);
      return { kind: 'needs-pairs', needed };
    }
    if (t.type === 'homography' && this.pairs().length < 4) {
      return { kind: 'unwarped', needed: 4 - this.pairs().length };
    }
    const reason = diagnoseHomography(t);
    if (reason) return { kind: 'bad-fit', reason };
    if (!this.movingImageUrl()) return { kind: 'no-image' };
    return { kind: 'ok' };
  });

  private dpr = Math.max(1, window.devicePixelRatio || 1);
  private resizeObs?: ResizeObserver;
  private lastSize = { w: 0, h: 0 };

  // ── Template-facing reactive state ──────────────────────────────────────

  readonly pairs = this.state.pairs;
  readonly placement = this.state.placement;
  readonly mode = this.state.mode;
  readonly vis = this.state.vis;
  readonly colorForIndex = colorForIndex;

  readonly pendingRef = computed(() => {
    const p = this.placement();
    return p.phase === 'awaiting-moving' ? p.pendingRef : null;
  });

  /** 1 / viewport scale: reticles are drawn in a group scaled by this, so
   *  their size on screen is constant. */
  readonly markerScale = computed(() => {
    const c = this.refController();
    return c ? 1 / Math.max(1e-4, c.scale()) : 1;
  });

  markerTransform(p: { x: number; y: number }): string {
    return `translate(${p.x} ${p.y}) scale(${this.markerScale()})`;
  }

  readonly warpedTransform = computed(() => {
    const t = this.state.transform();
    const refScale = this.refController().scale();
    const refOffset = this.refController().offset();

    if (t.type === 'homography') {
      return buildWarpedImageTransform(t, refScale, refOffset);
    }
    // No homography: translate and scale.
    return `translate(${refOffset.x}px, ${refOffset.y}px) scale(${refScale})`;
  });
  readonly showWarped = computed(() => {
    if (this.movingImageUrl() === null) return false;
    // A degenerate homography is hidden.
    const t = this.state.transform();
    if (t.type === 'homography' && diagnoseHomography(t) !== null) return false;
    return true;
  });
  /** Why the transform is degenerate, or null. */
  readonly warpedDiagnostic = computed(() =>
    diagnoseHomography(this.state.transform()),
  );

  readonly modeLabel = computed(() => {
    const m = this.mode();
    return m === 'overlay'
      ? 'Overlay'
      : m === 'checkerboard'
        ? 'Checkerboard'
        : '';
  });

  readonly maskId = `checker-mask-${Math.random().toString(36).slice(2, 9)}`;

  constructor() {
    effect(() => {
      const _track = [this.mode()];
      this.redrawReference();
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    if (!this.refController() || !this.movingController()) {
      queueMicrotask(() => {
        if (this.refController() && this.movingController()) {
          this.setupViewportEngine();
        }
      });
      return;
    }
    this.setupViewportEngine();
  }

  ngOnChanges(changes: SimpleChanges): void {
    const refPyramid = this.refPyramid();
    if (changes['refPyramid'] && refPyramid) {
      const { nativeWidth: w, nativeHeight: h } = refPyramid;
      const refController = this.refController();
      refController.smooth = Math.max(w, h) < 4096;
      const size = refController.size();
      if (size.width > 0 && size.height > 0) {
        refController.fitImage(w, h, false);
      }
      this.redrawReference();
      this.updateSvgViewBox();
    }
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    this.refController().onRedrawNeeded = undefined;
  }

  private setupViewportEngine(): void {
    this.refController().onRedrawNeeded = () => {
      this.redrawReference();
      this.updateSvgViewBox();
    };

    this.resizeObs = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w === 0 || h === 0) return;
      if (w === this.lastSize.w && h === this.lastSize.h) return;
      this.lastSize = { w, h };

      this.refController().setSize(w, h);
      this.movingController().setSize(w, h);
      this.resizeCanvas(w, h);
      this.redrawReference();
      this.updateSvgViewBox();
    });
    this.resizeObs.observe(this.hostEl().nativeElement);
  }

  // ── Reference canvas ─────────────────────────────────────────────────────

  private redrawReference(): void {
    const canvas = this.canvasEl()?.nativeElement;
    const refPyramid = this.refPyramid();
    if (!canvas || !refPyramid) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const level = this.pyramidSvc.getLevelForViewport(
      refPyramid,
      this.refController().scale(),
      this.refController().size().width,
      this.refController().size().height,
    );

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.refController().applyToContextForLevel(ctx, this.dpr, level);
    ctx.imageSmoothingEnabled = this.refController().scale() < 1;
    ctx.drawImage(level.canvas, 0, 0);
    ctx.restore();
  }

  private updateSvgViewBox(): void {
    const refPyramid = this.refPyramid();
    const svgEl = this.svgEl();
    if (!svgEl || !refPyramid) return;
    svgEl.nativeElement.setAttribute(
      'viewBox',
      this.refController().getSVGViewBox(
        refPyramid.nativeWidth,
        refPyramid.nativeHeight,
      ),
    );
  }

  private resizeCanvas(w: number, h: number): void {
    const canvas = this.canvasEl()?.nativeElement;
    if (!canvas) return;
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  // ── Pan and zoom ─────────────────────────────────────────────────────────

  private readonly gesture = new TouchGesture();

  // The middle button pans; so does a finger, and two fingers pinch.
  onMouseDown(event: PointerEvent): void {
    const touch = event.pointerType === 'touch';
    this.gesture.down(event);
    if (this.gesture.multi) {
      this.refController()?.endDrag();
      return;
    }
    if (touch) {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    }
    if (touch || event.button === 1) {
      this.refController()?.startDrag(event.clientX, event.clientY);
    }
  }

  onMouseMove(event: PointerEvent): void {
    const refController = this.refController();
    const step = this.gesture.move(event);
    if (this.gesture.multi) {
      if (step && refController) {
        const rect = this.canvasEl().nativeElement.getBoundingClientRect();
        refController.pinch(
          refController.clientToViewport(step.pivot.x, step.pivot.y, rect),
          step.factor,
          step.dx,
          step.dy,
        );
      }
      return;
    }
    if (refController?.isDragging) {
      refController?.drag(event.clientX, event.clientY);
    }
  }

  onMouseUp(event: PointerEvent): void {
    this.gesture.up(event);
    this.refController()?.endDrag();
  }

  onMouseLeave(): void {
    this.refController()?.endDrag();
  }

  onWheel(event: WheelEvent): void {
    const rect = this.canvasEl().nativeElement.getBoundingClientRect();
    this.refController()?.wheel(event, rect);
  }

  // ── Template helpers ─────────────────────────────────────────────────────

  get movingNativeWidth(): number {
    return this.movingPyramid()?.nativeWidth ?? 0;
  }
  get movingNativeHeight(): number {
    return this.movingPyramid()?.nativeHeight ?? 0;
  }
}
