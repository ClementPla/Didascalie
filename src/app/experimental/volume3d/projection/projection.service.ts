import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { ProjectScoped } from '../../../core/project-scoped';
import { SequenceService } from '../../../services/sequence.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { api } from '../../../lib/api';
import { CanvasManagerService } from '../../../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../../../features/editor/drawable-canvas/service/state-manager.service';
import { VectorEditorService } from '../../../features/editor/drawable-canvas/service/vector-editor.service';
import { distanceToShape, flattenShape } from '../../../features/editor/drawable-canvas/vector/vector.model';
import {
  Point,
  closestSpan,
  controlPointsFor,
  longestSkeletonPath,
  resampleByArcLength,
  splineLength,
} from './curve';

export type CurveId = 'a' | 'b';

export interface ProjectionCurves {
  a: Point[];
  b: Point[];
}

/** Output columns are capped: one per pixel of arc length up to this. */
const MAX_COLUMNS = 4096;

/**
 * The two curves of the projection view and what the view derives from them.
 *
 * The curves are drawn on the slice, in image pixels, and apply to every
 * slice (they are extruded along Z). Column `s` of the projection joins the
 * points at the same normalised arc length on each curve, so the curves need
 * neither the same length nor the same number of control points.
 *
 * Curves are remembered per sequence for the session; they are a viewing aid,
 * not annotations, and are never saved to the project.
 */
@Injectable({ providedIn: 'root' })
export class ProjectionService implements ProjectScoped {
  private readonly sequences = inject(SequenceService);
  private readonly labels = inject(LabelsService);
  private readonly canvasManager = inject(CanvasManagerService);
  private readonly state = inject(StateManagerService);
  private readonly vectorEditor = inject(VectorEditorService);
  private readonly bySequence = new Map<number, ProjectionCurves>();
  private activeSequence: number | null = null;

  readonly curves = signal<ProjectionCurves>({ a: [], b: [] });
  /** The curve new clicks on the canvas add points to, or null. */
  readonly placing = signal<CurveId | null>(null);
  /** The curve the next click on an annotation replaces, or null. */
  readonly picking = signal<CurveId | null>(null);
  /** The selected control point (Delete removes it), or null. */
  readonly selected = signal<{ id: CurveId; index: number } | null>(null);
  /** Why the last pick found nothing, shown until the next action. */
  readonly pickMessage = signal<string | null>(null);
  /** Projection column under the pointer in the projection view, or null. */
  readonly hoverColumn = signal<number | null>(null);

  /** Both curves have at least two points. */
  readonly ready = computed(() => {
    const { a, b } = this.curves();
    return a.length >= 2 && b.length >= 2;
  });

  /**
   * Segment endpoints per output column, `[ax, ay, bx, by]` each, or null
   * until both curves exist. One column per pixel of the longer curve.
   */
  readonly columns = computed<{ count: number; ends: Float32Array } | null>(() => {
    if (!this.ready()) return null;
    const { a, b } = this.curves();
    const count = Math.max(2, Math.min(MAX_COLUMNS, Math.round(Math.max(splineLength(a), splineLength(b))) + 1));
    const ra = resampleByArcLength(a, count);
    const rb = resampleByArcLength(b, count);
    const ends = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      ends[i * 4] = ra[i].x;
      ends[i * 4 + 1] = ra[i].y;
      ends[i * 4 + 2] = rb[i].x;
      ends[i * 4 + 3] = rb[i].y;
    }
    return { count, ends };
  });

  constructor() {
    // Each sequence has its own curves.
    effect(() => {
      const id = this.sequences.currentSequence()?.id ?? null;
      untracked(() => {
        if (id === this.activeSequence) return;
        this.activeSequence = id;
        this.placing.set(null);
        this.picking.set(null);
        this.selected.set(null);
        this.hoverColumn.set(null);
        this.curves.set((id != null && this.bySequence.get(id)) || { a: [], b: [] });
      });
    });
  }

  /** Start (re)drawing a curve: the next clicks on the canvas place its points. */
  startPlacing(id: CurveId): void {
    this.picking.set(null);
    this.selected.set(null);
    this.pickMessage.set(null);
    this.setCurve(id, []);
    this.placing.set(id);
  }

  /** The next click on an annotation of the slice becomes curve `id`. */
  startPicking(id: CurveId): void {
    this.placing.set(null);
    this.selected.set(null);
    this.pickMessage.set(null);
    this.picking.set(id);
  }

  cancelPicking(): void {
    this.picking.set(null);
  }

  /**
   * Make the curve being picked follow the annotation at `p` (image px) on
   * the current slice: a vector path within `tolerance` px becomes the curve
   * as drawn; otherwise a painted component under `p` is reduced to its
   * centerline (skeleton, longest route). Visible labels only, the active one
   * first.
   */
  async pickAt(p: Point, tolerance: number): Promise<void> {
    const id = this.picking();
    if (!id) return;
    const path = this.vectorPathAt(p, tolerance) ?? (await this.centerlineAt(p));
    if (!path || path.length < 2) {
      this.pickMessage.set('No label or path there. Click on an annotation of this slice.');
      return;
    }
    this.picking.set(null);
    this.pickMessage.set(null);
    this.setCurve(id, controlPointsFor(path));
  }

  private vectorPathAt(p: Point, tolerance: number): Point[] | null {
    const visible = new Set(this.labels.listSegmentationLabels.filter((l) => l.isVisible).map((l) => l.id));
    let best: { d: number; points: Point[] } | null = null;
    for (const shape of this.vectorEditor.shapes()) {
      if (!visible.has(shape.labelId)) continue;
      const d = distanceToShape(shape, p);
      if (d <= tolerance && (!best || d < best.d)) {
        const points = flattenShape(shape, 24);
        // A closed outline becomes a loop that returns to its start.
        if (shape.closed && points.length > 1) points.push({ ...points[0] });
        best = { d, points };
      }
    }
    return best?.points ?? null;
  }

  private async centerlineAt(p: Point): Promise<Point[] | null> {
    const w = this.state.width;
    const h = this.state.height;
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return null;
    const labels = this.labels.listSegmentationLabels;
    const masks = this.canvasManager.getAllMasks();
    const active = this.canvasManager.getActiveIndex();
    const order = [active, ...labels.map((_, i) => i).filter((i) => i !== active)];
    const index = order.find((i) => labels[i]?.isVisible && masks[i]?.[y * w + x]);
    if (index === undefined) return null;
    try {
      const branches = await api.skeletonizeComponent(masks[index], w, h, x, y);
      // Skeleton points are pixel indices; the curve runs through pixel centres.
      return longestSkeletonPath(branches.map((b) => b.map(([bx, by]) => ({ x: bx + 0.5, y: by + 0.5 }))));
    } catch (error) {
      console.error('Centerline extraction failed:', error);
      return null;
    }
  }

  finishPlacing(): void {
    this.placing.set(null);
  }

  addPoint(p: Point): void {
    const id = this.placing();
    if (!id) return;
    this.setCurve(id, [...this.curves()[id], p]);
  }

  /** Insert a point on the span of curve `id` nearest `p`, if within
   *  `tolerance` px. Returns whether it did. */
  insertPointNear(id: CurveId, p: Point, tolerance: number): boolean {
    const points = this.curves()[id];
    const span = closestSpan(points, p);
    if (!span || span.distance > tolerance) return false;
    const next = [...points];
    next.splice(span.index + 1, 0, p);
    this.setCurve(id, next);
    this.selected.set({ id, index: span.index + 1 });
    return true;
  }

  select(id: CurveId, index: number): void {
    this.selected.set({ id, index });
  }

  /** Remove the selected point, if any. Returns whether it did. */
  removeSelected(): boolean {
    const sel = this.selected();
    if (!sel) return false;
    this.removePoint(sel.id, sel.index);
    return true;
  }

  movePoint(id: CurveId, index: number, p: Point): void {
    const points = [...this.curves()[id]];
    if (index < 0 || index >= points.length) return;
    points[index] = p;
    this.setCurve(id, points);
  }

  removePoint(id: CurveId, index: number): void {
    this.selected.set(null);
    this.setCurve(id, this.curves()[id].filter((_, i) => i !== index));
  }

  /** Reverse a curve, flipping which end column 0 starts from. */
  reverse(id: CurveId): void {
    this.setCurve(id, [...this.curves()[id]].reverse());
  }

  clearCurve(id: CurveId): void {
    if (this.placing() === id) this.placing.set(null);
    if (this.picking() === id) this.picking.set(null);
    this.selected.set(null);
    this.setCurve(id, []);
  }

  clear(): void {
    this.placing.set(null);
    this.picking.set(null);
    this.selected.set(null);
    this.curves.set({ a: [], b: [] });
    if (this.activeSequence != null) this.bySequence.delete(this.activeSequence);
  }

  /** @see ProjectScoped — sequence ids restart in every project. */
  resetForProject(): void {
    this.bySequence.clear();
    this.activeSequence = null;
    this.placing.set(null);
    this.picking.set(null);
    this.selected.set(null);
    this.pickMessage.set(null);
    this.hoverColumn.set(null);
    this.curves.set({ a: [], b: [] });
  }

  private setCurve(id: CurveId, points: Point[]): void {
    const next = { ...this.curves(), [id]: points };
    this.curves.set(next);
    if (this.activeSequence != null) this.bySequence.set(this.activeSequence, next);
  }
}
