// components/composite-viewport/composite-viewport.component.ts

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
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { Pyramid, PyramidService } from '../../../../../Services/pyramid.service';
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
  @Input({ required: true }) refController!: ViewportController;
  @Input({ required: true }) movingController!: ViewportController;
  @Input() refPyramid: Pyramid | null = null;
  @Input() movingPyramid: Pyramid | null = null;
  /**
   * Source URL of the moving image to render via CSS transform.
   * Provided by the orchestrator alongside the pyramid.
   */
  @Input() movingImageUrl: string | null = null;

  @ViewChild('host') hostEl!: ElementRef<HTMLDivElement>;
  @ViewChild('canvas') canvasEl!: ElementRef<HTMLCanvasElement>;
  @ViewChild('svg') svgEl!: ElementRef<SVGSVGElement>;

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
    if (!this.movingImageUrl) return { kind: 'no-image' };
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

  /**
   * 1 / viewport scale. Keypoint reticles are drawn in a group scaled by this
   * so their geometry is in screen pixels — constant on-screen size at any
   * zoom, with the target pixel always visible through the open center.
   */
  readonly markerScale = computed(() => {
    const c = this.refController;
    return c ? 1 / Math.max(1e-4, c.scale()) : 1;
  });

  /** SVG transform placing a screen-pixel-sized marker at a native point. */
  markerTransform(p: { x: number; y: number }): string {
    return `translate(${p.x} ${p.y}) scale(${this.markerScale()})`;
  }

  /** CSS transform string for the warped moving <img>. */
  readonly warpedTransform = computed(() => {
    const t = this.state.transform();
    const refScale = this.refController.scale();
    const refOffset = this.refController.offset();

    if (t.type === 'homography') {
      return buildWarpedImageTransform(t, refScale, refOffset);
    }
    // Identity fallback: translate + scale, no homography.
    return `translate(${refOffset.x}px, ${refOffset.y}px) scale(${refScale})`;
  });
  readonly showWarped = computed(() => {
    if (this.movingImageUrl === null) return false;
    // If we have a homography and it's degenerate, hide rather than show garbage.
    const t = this.state.transform();
    if (t.type === 'homography' && diagnoseHomography(t) !== null) return false;
    return true;
  });
  /** Diagnostic: null when safe, string reason when transform is degenerate. */
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

  /** Stable id for the checkerboard mask (referenced from SVG). */
  readonly maskId = `checker-mask-${Math.random().toString(36).slice(2, 9)}`;

  constructor() {
    effect(() => {
      const _track = [this.mode()];
      this.redrawReference();
    });
  }

  // ==========================================
  // Lifecycle
  // ==========================================

  ngAfterViewInit(): void {
    if (!this.refController || !this.movingController) {
      // Re-check inside a short microtask execution deferral if initialization raced ahead
      queueMicrotask(() => {
        if (this.refController && this.movingController) {
          this.setupViewportEngine();
        }
      });
      return;
    }
    this.setupViewportEngine();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['refPyramid'] && this.refPyramid) {
      const { nativeWidth: w, nativeHeight: h } = this.refPyramid;
      this.refController.smooth = Math.max(w, h) < 4096;
      const size = this.refController.size();
      if (size.width > 0 && size.height > 0) {
        this.refController.fitImage(w, h, false);
      }
      this.redrawReference();
      this.updateSvgViewBox();
    }
  }

  ngOnDestroy(): void {
    this.resizeObs?.disconnect();
    this.refController.onRedrawNeeded = undefined;
  }

  private setupViewportEngine(): void {
    this.refController.onRedrawNeeded = () => {
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

      this.refController.setSize(w, h);
      this.movingController.setSize(w, h);
      this.resizeCanvas(w, h);
      this.redrawReference();
      this.updateSvgViewBox();
    });
    this.resizeObs.observe(this.hostEl.nativeElement);
  }

  // ==========================================
  // Reference canvas
  // ==========================================

  private redrawReference(): void {
    const canvas = this.canvasEl?.nativeElement;
    if (!canvas || !this.refPyramid) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const level = this.pyramidSvc.getLevelForViewport(
      this.refPyramid,
      this.refController.scale(),
      this.refController.size().width,
      this.refController.size().height,
    );

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.refController.applyToContextForLevel(ctx, this.dpr, level);
    ctx.imageSmoothingEnabled = this.refController.scale() < 1;
    ctx.drawImage(level.canvas, 0, 0);
    ctx.restore();
  }

  private updateSvgViewBox(): void {
    if (!this.svgEl || !this.refPyramid) return;
    this.svgEl.nativeElement.setAttribute(
      'viewBox',
      this.refController.getSVGViewBox(
        this.refPyramid.nativeWidth,
        this.refPyramid.nativeHeight,
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
  // Mouse handling — pan/zoom only
  // ==========================================

  onMouseDown(event: MouseEvent): void {
    if (event.button === 1) {
      this.refController?.startDrag(event.clientX, event.clientY);
    }
  }

  onMouseMove(event: MouseEvent): void {
    if (this.refController?.isDragging) {
      this.refController?.drag(event.clientX, event.clientY);
    }
  }

  onMouseUp(): void {
    this.refController?.endDrag();
  }

  onMouseLeave(): void {
    this.refController?.endDrag();
  }

  onWheel(event: WheelEvent): void {
    const rect = this.canvasEl.nativeElement.getBoundingClientRect();
    this.refController?.wheel(event, rect);
  }

  // ==========================================
  // Template helpers
  // ==========================================

  /** Native dimensions of the moving image, used to size the <img> element. */
  get movingNativeWidth(): number {
    return this.movingPyramid?.nativeWidth ?? 0;
  }
  get movingNativeHeight(): number {
    return this.movingPyramid?.nativeHeight ?? 0;
  }
}
