import {
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal, ChangeDetectionStrategy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MaskVolumeService } from '../../../services/mask-volume.service';
import { OrchestratorService } from '../../../features/editor/drawable-canvas/service/orchestrator.service';
import { EditorService } from '../../../features/editor/services/editor.service';
import { ZoomPanService } from '../../../features/editor/drawable-canvas/service/zoom-pan.service';
import { Point, splinePath } from './curve';
import { CurveId, ProjectionService } from './projection.service';
import { ProjectionPainterService } from './projection-painter.service';
import { Volume3dSettingsService } from '../volume3d-settings.service';

/** Screen-space sizes, in CSS px. */
const ANCHOR_RADIUS = 5;
const STROKE = 2;
/** How close (screen px) a double-click must be to a curve to insert, or a
 *  pick to a vector path to take it. */
const HIT = 8;
/** Correspondence lines drawn between the curves. */
const RULINGS = 9;

export const CURVE_COLORS: Record<CurveId, string> = { a: '#f5c2e7', b: '#94e2d5' };

/**
 * The projection curves over the editor canvas, in image coordinates (an SVG
 * whose viewBox follows the canvas's pan and zoom).
 *
 * The overlay lets input through to the canvas except on the curves: drag a
 * point to move it; click to select it (Delete removes it), or right-click /
 * Alt+click to remove it at once; double-click a curve to insert a point.
 * While a curve is being placed it takes every click: each adds a point, and
 * a double-click, Enter or Escape ends the curve. While one is being picked
 * from a label, the next click chooses the annotation.
 */
@Component({
  selector: 'app-curve-overlay',
  standalone: true,
  templateUrl: './curve-overlay.component.html',
  // Theme tokens rather than literals: SVG presentation attributes cannot carry
  // `var()`, so the accent colour lives in a class instead of on the element.
  styles: `
    .curve-accent-stroke { stroke: var(--p-amber-300, #f9e2af); }
    .curve-accent-fill { fill: var(--p-amber-300, #f9e2af); }
  `,
  host: {
    class: 'absolute inset-0 pointer-events-none z-[35]',
    '[class.hidden]': '!visible()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurveOverlayComponent {
  readonly projection = inject(ProjectionService);
  private readonly volume = inject(MaskVolumeService);
  private readonly zoomPan = inject(ZoomPanService);
  private readonly orchestrator = inject(OrchestratorService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly editor = inject(EditorService);
  private readonly painter = inject(ProjectionPainterService);
  private readonly settings = inject(Volume3dSettingsService).settings;

  readonly colors = CURVE_COLORS;
  readonly viewBox = signal('0 0 1 1');
  /** Image px per screen px: keeps anchors and strokes a fixed screen size. */
  readonly unit = signal(1);

  readonly visible = computed(() => this.volume.enabled());
  /** The overlay takes every click while placing or picking. */
  readonly capturing = computed(() => !!this.projection.placing() || !!this.projection.picking());
  readonly pathA = computed(() => splinePath(this.projection.curves().a));
  readonly pathB = computed(() => splinePath(this.projection.curves().b));
  readonly anchorRadius = computed(() => ANCHOR_RADIUS * this.unit());
  readonly strokeWidth = STROKE;

  /** A few evenly spaced columns, to show which points correspond. */
  readonly rulings = computed(() => {
    const columns = this.projection.columns();
    if (!columns) return [];
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    for (let k = 0; k < RULINGS; k++) {
      const i = Math.round((k * (columns.count - 1)) / (RULINGS - 1));
      out.push(segment(columns.ends, i));
    }
    return out;
  });

  /** Where projection strokes land: the curve at depth t between A and B,
   *  shown while painting or while the projection shows that surface. */
  readonly depthLine = computed(() => {
    const columns = this.projection.columns();
    const { projectionDepth: t, projectionMode } = this.settings();
    if (!columns || !(this.painter.editing() || projectionMode === 'depth')) return null;
    const { ends, count } = columns;
    const step = Math.max(1, Math.floor(count / 256));
    const points: string[] = [];
    for (let i = 0; i < count; i += step) points.push(depthPoint(ends, i, t));
    if ((count - 1) % step !== 0) points.push(depthPoint(ends, count - 1, t));
    return points.join(' ');
  });

  /** The hovered column's point at depth t. */
  readonly hoveredDepth = computed(() => {
    const h = this.hovered();
    if (!h || !this.depthLine()) return null;
    const t = this.settings().projectionDepth;
    return { x: h.x1 + (h.x2 - h.x1) * t, y: h.y1 + (h.y2 - h.y1) * t };
  });

  readonly hovered = computed(() => {
    const columns = this.projection.columns();
    const col = this.projection.hoverColumn();
    if (!columns || col == null || col < 0 || col >= columns.count) return null;
    return segment(columns.ends, col);
  });

  private drag: { id: CurveId; index: number; pointerId: number } | null = null;

  /** Banner text while the overlay is capturing clicks. */
  readonly banner = computed(() => {
    const placing = this.projection.placing();
    if (placing) {
      const n = this.projection.curves()[placing].length;
      return `Drawing curve ${placing.toUpperCase()} (${n} point${n === 1 ? '' : 's'}): click to add points · double-click, Enter or right-click to finish`;
    }
    const picking = this.projection.picking();
    if (picking) {
      return this.projection.pickMessage() ?? `Click a label or path to use as curve ${picking.toUpperCase()}`;
    }
    return null;
  });
  readonly bannerColor = computed(() => {
    const id = this.projection.placing() ?? this.projection.picking();
    return id ? CURVE_COLORS[id] : null;
  });

  constructor() {
    this.orchestrator.redrawRequest
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.syncViewBox());
    queueMicrotask(() => this.syncViewBox());

    // Starting a mode from a button leaves that button focused, and Enter
    // would press it again: drop the focus.
    effect(() => {
      if (this.capturing()) (document.activeElement as HTMLElement | null)?.blur?.();
    });

    // Enter / Escape end placing or picking before anything else sees them.
    const onKey = (event: KeyboardEvent) => {
      if (!this.capturing() || (event.key !== 'Enter' && event.key !== 'Escape')) return;
      event.preventDefault();
      event.stopPropagation();
      this.finish();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    inject(DestroyRef).onDestroy(() => window.removeEventListener('keydown', onKey, { capture: true }));
  }

  /** End placing / picking (the Done button, Enter, double-click...). */
  finish(): void {
    this.projection.finishPlacing();
    this.projection.cancelPicking();
  }

  private syncViewBox(): void {
    const box = this.zoomPan.getSVGViewBox();
    this.viewBox.set(`${box.x} ${box.y} ${Math.max(box.width, 1e-3)} ${Math.max(box.height, 1e-3)}`);
    const scale = this.zoomPan.getScale();
    if (scale > 0) this.unit.set(1 / scale);
  }

  // ==========================================
  // Placing
  // ==========================================

  onBackgroundClick(event: MouseEvent): void {
    // A left drag with the pan tool pans; it does not place a point.
    if (event.button !== 0 || this.editor.canPan()) return;
    if (this.projection.picking()) {
      void this.projection.pickAt(this.imagePoint(event), HIT * this.unit());
      return;
    }
    if (!this.projection.placing()) return;
    // The second click of a double-click ends the curve (the first one added
    // its last point). Read from the click itself: a separate dblclick event
    // is not reliable across webviews.
    if (event.detail >= 2) {
      this.projection.finishPlacing();
      return;
    }
    this.projection.addPoint(this.imagePoint(event));
  }

  /** Right-click ends placing too. */
  onBackgroundContextMenu(event: MouseEvent): void {
    event.preventDefault();
    if (this.capturing()) this.finish();
  }

  /** Keep zooming and panning the canvas while placing. */
  onBackgroundWheel(event: WheelEvent): void {
    this.canvas()?.dispatchEvent(new WheelEvent('wheel', event));
    event.preventDefault();
  }

  /** Whether a mouse press belongs to the canvas rather than to the curve:
   *  the middle button (pan), or any button while the pan tool is active. */
  private panning = false;

  onBackgroundMouseDown(event: MouseEvent): void {
    if (event.button === 1 || (event.button === 0 && this.editor.canPan())) {
      this.panning = true;
      event.preventDefault(); // no autoscroll on middle click
      this.forward(event);
    }
  }

  /** The canvas also tracks the cursor (rulers, brush), not only drags. */
  onBackgroundMouseMove(event: MouseEvent): void {
    this.forward(event);
  }

  onBackgroundMouseUp(event: MouseEvent): void {
    if (!this.panning) return;
    this.panning = false;
    this.forward(event);
  }

  private forward(event: MouseEvent): void {
    this.canvas()?.dispatchEvent(new MouseEvent(event.type, event));
  }

  /** The editor canvas under the overlay. */
  private canvas(): Element | null | undefined {
    return this.host.nativeElement.parentElement?.querySelector('canvas[appCanvasInput]');
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    this.projection.selected.set(null);
  }

  @HostListener('window:keydown.delete', ['$event'])
  @HostListener('window:keydown.backspace', ['$event'])
  onDeleteKey(event: KeyboardEvent): void {
    // Vector tools own Delete for their own selection.
    if (this.editor.isVectorTool() || isEditable(event.target)) return;
    if (this.projection.removeSelected()) event.preventDefault();
  }

  /** Any press outside the curve points drops the point selection. */
  @HostListener('window:pointerdown', ['$event'])
  onAnyPointerDown(event: PointerEvent): void {
    if (!(event.target as Element | null)?.closest?.('[data-curve-anchor]')) {
      this.projection.selected.set(null);
    }
  }

  // ==========================================
  // Curves
  // ==========================================

  onCurveDoubleClick(event: MouseEvent, id: CurveId): void {
    event.stopPropagation();
    if (this.projection.placing()) {
      this.projection.finishPlacing();
      return;
    }
    this.projection.insertPointNear(id, this.imagePoint(event), HIT * this.unit());
  }

  // ==========================================
  // Anchors
  // ==========================================

  onAnchorDown(event: PointerEvent, id: CurveId, index: number): void {
    event.stopPropagation();
    event.preventDefault();
    if (event.button === 2 || (event.button === 0 && event.altKey)) {
      this.projection.removePoint(id, index);
      return;
    }
    if (event.button !== 0) return;
    (event.target as Element).setPointerCapture(event.pointerId);
    this.projection.select(id, index);
    this.drag = { id, index, pointerId: event.pointerId };
  }

  onAnchorMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.projection.movePoint(drag.id, drag.index, this.imagePoint(event));
  }

  onAnchorUp(event: PointerEvent): void {
    if (this.drag?.pointerId === event.pointerId) this.drag = null;
  }

  /** Clamped to the image: points outside it would project nothing. */
  private imagePoint(event: MouseEvent): Point {
    const p = this.zoomPan.getImageCoordinatesRaw(event);
    const w = this.orchestrator.width;
    const h = this.orchestrator.height;
    return { x: Math.min(Math.max(p.x, 0), w), y: Math.min(Math.max(p.y, 0), h) };
  }
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

function depthPoint(ends: Float32Array, i: number, t: number): string {
  const x = ends[i * 4] + (ends[i * 4 + 2] - ends[i * 4]) * t;
  const y = ends[i * 4 + 1] + (ends[i * 4 + 3] - ends[i * 4 + 1]) * t;
  return `${x},${y}`;
}

function segment(ends: Float32Array, i: number) {
  return { x1: ends[i * 4], y1: ends[i * 4 + 1], x2: ends[i * 4 + 2], y2: ends[i * 4 + 3] };
}
