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
import { PyramidView } from '../../pyramid-view';
import { MIN_HOMOGRAPHY_PAIRS } from '../../registration.model';
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
  /** The reference image; the moving one is an <img> warped by CSS. */
  private readonly view = new PyramidView(
    inject(PyramidService),
    () => this.refController(),
    () => this.refPyramid(),
    (w, h) => this.movingController().setSize(w, h),
  );

  readonly warpStatus = computed<
    | { kind: 'ok' }
    | { kind: 'unwarped'; needed: number }
    | { kind: 'needs-pairs'; needed: number }
    | { kind: 'bad-fit'; reason: string }
    | { kind: 'no-image' }
  >(() => {
    const t = this.state.transform();
    if (t.type === 'identity') {
      const needed = Math.max(0, MIN_HOMOGRAPHY_PAIRS - this.pairs().length);
      return { kind: 'needs-pairs', needed };
    }
    if (t.type === 'homography' && this.pairs().length < MIN_HOMOGRAPHY_PAIRS) {
      return { kind: 'unwarped', needed: MIN_HOMOGRAPHY_PAIRS - this.pairs().length };
    }
    const reason = diagnoseHomography(t);
    if (reason) return { kind: 'bad-fit', reason };
    if (!this.movingImageUrl()) return { kind: 'no-image' };
    return { kind: 'ok' };
  });

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

  constructor() {
    effect(() => {
      this.mode(); // redraw when it changes
      this.view.redraw();
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  ngAfterViewInit(): void {
    this.view.attach({
      host: this.hostEl().nativeElement,
      canvas: this.canvasEl().nativeElement,
      svg: this.svgEl().nativeElement,
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['refPyramid']) this.view.pyramidChanged();
  }

  ngOnDestroy(): void {
    this.view.detach();
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
      if (step) this.view.pinch(step);
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
    this.view.wheel(event);
  }

  // ── Template helpers ─────────────────────────────────────────────────────

  get movingNativeWidth(): number {
    return this.movingPyramid()?.nativeWidth ?? 0;
  }
  get movingNativeHeight(): number {
    return this.movingPyramid()?.nativeHeight ?? 0;
  }
}
