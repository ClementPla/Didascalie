import { TAP_SLOP } from '../../../../core/touch';
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
  signal,
  input,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { applyTransform, invertHomography, Point2D } from '../../registration.model';
import { Pyramid, PyramidService } from '../../../../services/pyramid.service';
import { ViewportController } from '../../viewport-controller';
import { PyramidView } from '../../pyramid-view';
import {
  RegistrationStateService,
  colorForIndex,
} from '../../registration-state.service';
import {
  buildWarpedImageTransform,
  diagnoseHomography,
  inverseMapToMoving,
  mapMovingToRef,
} from '../../render-warp';

export type PaneSide = 'ref' | 'moving';
@Component({
  selector: 'app-viewport-pane',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule],
  templateUrl: './viewport-pane.component.html',
  styleUrl: './viewport-pane.component.scss',
})
export class ViewportPaneComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  readonly side = input.required<PaneSide>();
  readonly controller = input.required<ViewportController>();
  readonly pyramid = input<Pyramid | null>(null);
  readonly label = input('');

  readonly hostEl = viewChild.required<ElementRef<HTMLDivElement>>('host');
  readonly canvasEl = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  readonly svgEl = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  readonly movingImageUrl = input<string | null>(null);
  private readonly state = inject(RegistrationStateService);
  private readonly view = new PyramidView(
    inject(PyramidService),
    () => this.controller(),
    () => this.pyramid(),
  );

  /** Drag state for an existing pair point on this pane. */
  private draggingPairId: string | null = null;

  private readonly gesture = new TouchGesture();
  /** Where a finger went down on empty image, until it proves a tap (a point
   *  is placed on lift) or a drag (the image pans). */
  private pendingTap: { clientX: number; clientY: number; native: Point2D } | null =
    null;

  private readonly localHoverPairId = signal<string | null>(null);

  readonly cursorStyle = computed(() =>
    this.localHoverPairId() !== null ? 'grab' : 'crosshair',
  );

  // ── Template-facing signals/computeds ───────────────────────────────────

  readonly pairs = this.state.pairs;
  readonly placement = this.state.placement;
  readonly transform = this.state.transform;
  readonly colorForIndex = colorForIndex;
  readonly hoveredPairId = this.state.hoveredPairId;
  /** 1 / viewport scale: markers are drawn in a group scaled by this, so their
   *  size on screen is constant. */
  readonly markerScale = computed(() => {
    const c = this.controller();
    return c ? 1 / Math.max(1e-4, c.scale()) : 1;
  });
  /** The pending reference point while the moving one is awaited. Reference
   *  pane only. */
  readonly pendingRef = computed(() => {
    const p = this.placement();
    return p.phase === 'awaiting-moving' ? p.pendingRef : null;
  });

  readonly pendingMoving = computed(() => {
    const p = this.placement();
    return p.phase === 'awaiting-ref' ? p.pendingMoving : null;
  });

  readonly predictedMoving = computed(() => {
    const pending = this.pendingRef();
    if (!pending) return null;
    return inverseMapToMoving(pending, this.transform());
  });

  readonly predictedRef = computed(() => {
    const pending = this.pendingMoving();
    if (!pending) return null;
    return mapMovingToRef(pending, this.transform());
  });

  constructor() {
    // Redraw when any of these changes.
    effect(() => {
      this.pairs();
      this.transform();
      void this.state.vis().showMovingWarped;
      this.hoveredPairId();
      this.view.redraw();
    });
  }

  ngAfterViewInit(): void {
    this.view.attach({
      host: this.hostEl().nativeElement,
      canvas: this.canvasEl().nativeElement,
      svg: this.svgEl().nativeElement,
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['pyramid']) this.view.pyramidChanged();
  }

  ngOnDestroy(): void {
    this.view.detach();
  }
  readonly shouldShowWarped = computed(
    () =>
      this.side() === 'moving' &&
      this.state.vis().showMovingWarped &&
      this.state.transform().type === 'homography',
  );

  readonly warpedTransform = computed(() => {
    if (!this.shouldShowWarped()) return null;
    return buildWarpedImageTransform(
      this.state.transform(),
      this.controller().scale(), // moving controller, synced with ref via SyncGroup
      this.controller().offset(),
    );
  });

  readonly warpedDiagnostic = computed(() =>
    this.shouldShowWarped() ? diagnoseHomography(this.state.transform()) : null,
  );

  readonly showWarpedImg = computed(
    () =>
      this.shouldShowWarped() &&
      this.warpedTransform() !== null &&
      this.warpedDiagnostic() === null &&
      this.movingImageUrl() !== null,
  );

  // ── Mouse handling ───────────────────────────────────────────────────────

  // Pointer events, for mouse, pen and finger. A finger places a point when it
  // lifts, not when it lands, so that it can pan instead; two fingers pan and
  // pinch.

  onMouseDown(event: PointerEvent): void {
    const touch = event.pointerType === 'touch';
    this.gesture.down(event);
    if (this.gesture.multi) {
      this.pendingTap = null;
      this.draggingPairId = null;
      this.controller().endDrag();
      return;
    }
    if (touch) {
      (event.currentTarget as Element).setPointerCapture(event.pointerId);
    }

    if (event.button === 1) {
      this.controller().startDrag(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) return;

    // No placement on the moving pane while the warp overlay shows.
    if (this.shouldShowWarped()) return;
    const rect = this.view.canvasRect();
    const native = this.controller().clientToNative(
      event.clientX,
      event.clientY,
      rect,
    );

    const hit = this.hitTestPair(native);
    if (hit) {
      this.draggingPairId = hit;
      return;
    }

    if (touch) {
      this.pendingTap = { clientX: event.clientX, clientY: event.clientY, native };
      return;
    }
    this.placePoint(native);
  }

  private placePoint(native: Point2D): void {
    if (this.side() === 'ref') {
      this.state.placeRefPoint(native);
    } else {
      this.state.placeMovingPoint(native);
    }
  }

  onMouseMove(event: PointerEvent): void {
    const controller = this.controller();
    const step = this.gesture.move(event);
    if (this.gesture.multi) {
      if (step) this.view.pinch(step);
      return;
    }
    if (this.pendingTap) {
      const moved = Math.hypot(
        event.clientX - this.pendingTap.clientX,
        event.clientY - this.pendingTap.clientY,
      );
      if (moved < TAP_SLOP) return;
      // Not a tap: the finger is dragging the image.
      controller.startDrag(this.pendingTap.clientX, this.pendingTap.clientY);
      this.pendingTap = null;
    }
    if (controller.isDragging) {
      controller.drag(event.clientX, event.clientY);
      return;
    }
    if (this.draggingPairId) {
      const rect = this.view.canvasRect();
      const native = controller.clientToNative(
        event.clientX,
        event.clientY,
        rect,
      );
      if (this.side() === 'ref') {
        this.state.updatePairRef(this.draggingPairId, native);
      } else {
        this.state.updatePairMoving(this.draggingPairId, native);
      }
      return;
    }

    const rect = this.view.canvasRect();
    const native = controller.clientToNative(
      event.clientX,
      event.clientY,
      rect,
    );
    this.state.setHoverPoint(this.side(), native);
    const hit = this.hitTestPair(native);
    this.localHoverPairId.set(hit);
    this.state.setHoveredPair(hit);
  }

  onMouseLeave(): void {
    this.controller().endDrag();
    this.localHoverPairId.set(null);
    this.state.setHoveredPair(null);
  }

  onMouseUp(event: PointerEvent): void {
    const tap = this.gesture.multi ? null : this.pendingTap;
    this.gesture.up(event);
    this.pendingTap = null;
    this.controller().endDrag();
    this.draggingPairId = null;
    if (tap && event.type === 'pointerup') this.placePoint(tap.native);
  }

  onWheel(event: WheelEvent): void {
    this.view.wheel(event);
  }
  readonly shadowCursor = computed<Point2D | null>(() => {
    if (!this.state.vis().showShadowCursor) return null;
    const hover = this.state.hoverPoint();
    if (!hover) return null;

    // The shadow shows on the pane opposite the mouse.
    const side = this.side();
    if (hover.side === side) return null;

    const t = this.state.transform();
    if (t.type !== 'homography') return null;

    if (hover.side === 'ref' && side === 'moving') {
      // ref → moving, through H⁻¹.
      const inv = invertHomography(t);
      if (!inv) return null;
      return applyTransform(inv, hover.pt);
    } else if (hover.side === 'moving' && side === 'ref') {
      // moving → ref, through H.
      return applyTransform(t, hover.pt);
    }
    return null;
  });

  private hitTestPair(native: Point2D): string | null {
    const scale = Math.max(0.001, this.controller().scale());
    const radius = Math.min(60, 12 / scale);
    const sq = radius * radius;
    for (const p of this.pairs()) {
      const target = this.side() === 'ref' ? p.ref : p.moving;
      const dx = target.x - native.x;
      const dy = target.y - native.y;
      if (dx * dx + dy * dy < sq) return p.id;
    }
    return null;
  }

  // ── Template helpers ─────────────────────────────────────────────────────

  pointFor(pair: { ref: Point2D; moving: Point2D }): Point2D {
    return this.side() === 'ref' ? pair.ref : pair.moving;
  }

  /** SVG transform placing a marker at a native-pixel point, at a constant
   *  size on screen. */
  markerTransform(p: Point2D): string {
    return `translate(${p.x} ${p.y}) scale(${this.markerScale()})`;
  }

  get showPendingRef(): boolean {
    return this.side() === 'ref' && this.pendingRef() !== null;
  }
  get showPendingMoving(): boolean {
    return this.side() === 'moving' && this.pendingMoving() !== null;
  }

  get showPredictedMoving(): boolean {
    return this.side() === 'moving' && this.predictedMoving() !== null;
  }

  get showPredictedRef(): boolean {
    return this.side() === 'ref' && this.predictedRef() !== null;
  }
  get movingNativeWidth(): number {
    return this.pyramid()?.nativeWidth ?? 0;
  }
  get movingNativeHeight(): number {
    return this.pyramid()?.nativeHeight ?? 0;
  }
}
