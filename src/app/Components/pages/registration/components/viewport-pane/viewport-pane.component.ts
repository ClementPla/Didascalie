import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Input,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { applyTransform, invertHomography, Point2D } from '../../registration.model';
import { Pyramid, PyramidService } from '../../pyramid.service';
import { ViewportController } from '../../viewport-controller';
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
  @Input({ required: true }) side!: PaneSide;
  @Input({ required: true }) controller!: ViewportController;
  @Input() pyramid: Pyramid | null = null;
  @Input() label = '';

  @ViewChild('host') hostEl!: ElementRef<HTMLDivElement>;
  @ViewChild('canvas') canvasEl!: ElementRef<HTMLCanvasElement>;
  @ViewChild('svg') svgEl!: ElementRef<SVGSVGElement>;
  @Input() movingImageUrl: string | null = null;
  private readonly state = inject(RegistrationStateService);
  private readonly pyramidSvc = inject(PyramidService);

  private dpr = Math.max(1, window.devicePixelRatio || 1);
  private resizeObs?: ResizeObserver;
  private lastSize = { w: 0, h: 0 };

  /** Drag state for an existing pair point on this pane. */
  private draggingPairId: string | null = null;

  private readonly localHoverPairId = signal<string | null>(null);

  /** Cursor style for the host div. */
  readonly cursorStyle = computed(() =>
    this.localHoverPairId() !== null ? 'grab' : 'crosshair',
  );

  // ── Template-facing signals/computeds ───────────────────────────────────

  readonly pairs = this.state.pairs;
  readonly placement = this.state.placement;
  readonly transform = this.state.transform;
  readonly colorForIndex = colorForIndex;
  readonly hoveredPairId = this.state.hoveredPairId;
  /**
   * 1 / viewport scale. Markers are drawn in this scaled group so their
   * geometry is expressed in screen pixels — they stay a constant, crisp
   * on-screen size at any zoom and never bloat over the target pixel.
   */
  readonly markerScale = computed(() => {
    const c = this.controller;
    return c ? 1 / Math.max(1e-4, c.scale()) : 1;
  });
  /**
   * The pending reference point during the awaiting-moving phase.
   * Rendered only on the reference pane.
   */
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

  readonly residualSegments = computed<Array<{ from: Point2D; to: Point2D }>>(
    () => {
      if (this.side !== 'moving') return [];
      const t = this.transform();
      if (t.type !== 'homography') return [];
      return this.pairs().map((p) => {
        const predicted = inverseMapToMoving(mapMovingToRef(p.moving, t), t);
        return predicted
          ? { from: p.moving, to: predicted }
          : { from: p.moving, to: p.moving };
      });
    },
  );

  constructor() {
    effect(() => {
      const _track = [
        this.pairs(),
        this.transform(),
        this.state.vis().showMovingWarped,
        this.hoveredPairId(),
      ];
      this.redraw();
    });
  }

  ngAfterViewInit(): void {
    this.controller.onRedrawNeeded = () => {
      this.redraw();
      this.updateSvgViewBox();
    };

    this.resizeObs = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (w === 0 || h === 0) return;
      if (w === this.lastSize.w && h === this.lastSize.h) return;
      this.lastSize = { w, h };

      this.controller.setSize(w, h);
      this.resizeCanvas(w, h);
      this.redraw();
      this.updateSvgViewBox();
    });
    this.resizeObs.observe(this.hostEl.nativeElement);
  }

  ngOnChanges(changes: SimpleChanges): void {
    // When the pyramid input changes (new frame loaded), fit & redraw.
    if (changes['pyramid'] && this.pyramid) {
      const { nativeWidth: w, nativeHeight: h } = this.pyramid;
      this.controller.smooth = Math.max(w, h) < 4096;
      // Only fit if the controller has been sized — otherwise the fit
      // math divides by zero and we wait for the ResizeObserver tick.
      const size = this.controller.size();
      if (size.width > 0 && size.height > 0) {
        this.controller.fitImage(w, h, false);
      }
      this.redraw();
      this.updateSvgViewBox();
    }
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    this.controller.onRedrawNeeded = undefined;
  }
  readonly shouldShowWarped = computed(
    () =>
      this.side === 'moving' &&
      this.state.vis().showMovingWarped &&
      this.state.transform().type === 'homography',
  );

  /** CSS transform string for the warped <img>. */
  readonly warpedTransform = computed(() => {
    if (!this.shouldShowWarped()) return null;
    return buildWarpedImageTransform(
      this.state.transform(),
      this.controller.scale(), // moving controller, synced with ref via SyncGroup
      this.controller.offset(),
    );
  });

  readonly warpedDiagnostic = computed(() =>
    this.shouldShowWarped() ? diagnoseHomography(this.state.transform()) : null,
  );

  /** Whether to actually render the <img> (gates on URL availability + safety). */
  readonly showWarpedImg = computed(
    () =>
      this.shouldShowWarped() &&
      this.warpedTransform() !== null &&
      this.warpedDiagnostic() === null &&
      this.movingImageUrl !== null,
  );

  private redraw(): void {
    const canvas = this.canvasEl?.nativeElement;
    if (!canvas || !this.pyramid) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const level = this.pyramidSvc.getLevelForViewport(
      this.pyramid,
      this.controller.scale(),
      this.controller.size().width,
      this.controller.size().height,
    );

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.controller.applyToContextForLevel(ctx, this.dpr, level);
    ctx.imageSmoothingEnabled = this.controller.scale() < 1;
    ctx.drawImage(level.canvas, 0, 0);
    ctx.restore();
  }

  private updateSvgViewBox(): void {
    if (!this.svgEl || !this.pyramid) return;
    this.svgEl.nativeElement.setAttribute(
      'viewBox',
      this.controller.getSVGViewBox(
        this.pyramid.nativeWidth,
        this.pyramid.nativeHeight,
      ),
    );
  }

  private resizeCanvas(w: number, h: number): void {
    const canvas = this.canvasEl?.nativeElement;
    if (!canvas) return;
    canvas.width = Math.round(w * this.dpr);
    canvas.height = Math.round(h * this.dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }

  // ==========================================
  // Mouse handling
  // ==========================================

  onMouseDown(event: MouseEvent): void {
    if (event.button === 1) {
      this.controller.startDrag(event.clientX, event.clientY);
      return;
    }
    if (event.button !== 0) return;

    // Block placement on the moving pane while the warp overlay is showing.
    if (this.shouldShowWarped()) return;
    const rect = this.canvasEl.nativeElement.getBoundingClientRect();
    const native = this.controller.clientToNative(
      event.clientX,
      event.clientY,
      rect,
    );

    // Drag an existing point on this side if the click is close enough.
    const hit = this.hitTestPair(native);
    if (hit) {
      this.draggingPairId = hit;
      return;
    }

    // Otherwise, register the click with the placement state machine.
    if (this.side === 'ref') {
      this.state.placeRefPoint(native);
    } else {
      this.state.placeMovingPoint(native);
    }
  }

  onMouseMove(event: MouseEvent): void {
    if (this.controller.isDragging) {
      this.controller.drag(event.clientX, event.clientY);
      return;
    }
    if (this.draggingPairId) {
      const rect = this.canvasEl.nativeElement.getBoundingClientRect();
      const native = this.controller.clientToNative(
        event.clientX,
        event.clientY,
        rect,
      );
      if (this.side === 'ref') {
        this.state.updatePairRef(this.draggingPairId, native);
      } else {
        this.state.updatePairMoving(this.draggingPairId, native);
      }
      return;
    }

    // Hover detection — runs only when not dragging.
    const rect = this.canvasEl.nativeElement.getBoundingClientRect();
    const native = this.controller.clientToNative(
      event.clientX,
      event.clientY,
      rect,
    );
    this.state.setHoverPoint(this.side, native);
    const hit = this.hitTestPair(native);
    this.localHoverPairId.set(hit);
    this.state.setHoveredPair(hit);
  }

  onMouseLeave(): void {
    this.controller.endDrag();
    this.localHoverPairId.set(null);
    this.state.setHoveredPair(null);
  }

  onMouseUp(): void {
    this.controller.endDrag();
    this.draggingPairId = null;
  }

  onWheel(event: WheelEvent): void {
    const rect = this.canvasEl.nativeElement.getBoundingClientRect();
    this.controller.wheel(event, rect);
  }
  readonly shadowCursor = computed<Point2D | null>(() => {
    if (!this.state.vis().showShadowCursor) return null;
    const hover = this.state.hoverPoint();
    if (!hover) return null;

    // Only show shadow on the OPPOSITE pane from where the mouse is.
    if (hover.side === this.side) return null;

    const t = this.state.transform();
    if (t.type !== 'homography') return null;

    // Mouse on ref → show shadow on moving (use inverse homography: ref → moving).
    // Mouse on moving → show shadow on ref (use forward homography: moving → ref).
    if (hover.side === 'ref' && this.side === 'moving') {
      // Map ref point to moving via H⁻¹.
      const inv = invertHomography(t);
      if (!inv) return null;
      return applyTransform(inv, hover.pt);
    } else if (hover.side === 'moving' && this.side === 'ref') {
      // Map moving point to ref via H.
      return applyTransform(t, hover.pt);
    }
    return null;
  });

  private hitTestPair(native: Point2D): string | null {
    const scale = Math.max(0.001, this.controller.scale());
    const radius = Math.min(60, 12 / scale);
    const sq = radius * radius;
    for (const p of this.pairs()) {
      const target = this.side === 'ref' ? p.ref : p.moving;
      const dx = target.x - native.x;
      const dy = target.y - native.y;
      if (dx * dx + dy * dy < sq) return p.id;
    }
    return null;
  }

  // ==========================================
  // Template helpers
  // ==========================================

  /** The point on this side for a pair. */
  pointFor(pair: { ref: Point2D; moving: Point2D }): Point2D {
    return this.side === 'ref' ? pair.ref : pair.moving;
  }

  /**
   * SVG transform placing a marker at a native-pixel point and scaling its
   * (screen-pixel) geometry by 1/scale so it renders at a constant size.
   */
  markerTransform(p: Point2D): string {
    return `translate(${p.x} ${p.y}) scale(${this.markerScale()})`;
  }

  /** True if the awaiting-moving placement marker should render. */
  get showPendingRef(): boolean {
    return this.side === 'ref' && this.pendingRef() !== null;
  }
  get showPendingMoving(): boolean {
    return this.side === 'moving' && this.pendingMoving() !== null;
  }

  /** True if the predicted-moving indicator should render. */
  get showPredictedMoving(): boolean {
    return this.side === 'moving' && this.predictedMoving() !== null;
  }

  get showPredictedRef(): boolean {
    return this.side === 'ref' && this.predictedRef() !== null;
  }
  get movingNativeWidth(): number {
    return this.pyramid?.nativeWidth ?? 0;
  }
  get movingNativeHeight(): number {
    return this.pyramid?.nativeHeight ?? 0;
  }
}
