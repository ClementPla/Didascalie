import { Injectable } from '@angular/core';

import { api } from '../../../../../lib/api';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { UndoRedoService } from './undo-redo.service';
import { VectorEditorService } from './vector-editor.service';
import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { ProjectService } from '../../../../../Services/ProjectService/project.service';
import { IOService } from '../../../../../Services/io.service';
import {
  Rect,
  commitStroke,
  intRect,
  clearValueComponentAt,
} from '../../../../../Core/misc/label-ops';
import {
  Pt,
  VectorShape,
  buildPathData,
  makeNode,
  shapeBounds,
} from '../vector/vector.model';

/**
 * Bridges the raster (uint8 masks) and vector (SVG shapes) subsystems:
 *
 * - **rasterize**: burn vector shapes into their label's mask, then remove the
 *   shapes (a true convert).
 * - **vectorize**: trace one connected component of a label mask into a closed
 *   filled shape, then clear those pixels.
 *
 * Both are single undoable actions: the raster snapshot and the vector commit
 * are wrapped in one compound entry via UndoRedoService.beginGroup/endGroup.
 */
@Injectable({ providedIn: 'root' })
export class ConvertService {
  constructor(
    private canvasManager: CanvasManagerService,
    private state: StateManagerService,
    private undoRedo: UndoRedoService,
    private vectorEditor: VectorEditorService,
    private editor: EditorService,
    private labels: LabelsService,
    private project: ProjectService,
    private io: IOService,
  ) {}

  // ── Rasterize (vector → raster) ─────────────────────────────────────────────

  /**
   * Burn shapes into the label masks and delete them. Rasterizes the selected
   * shape if one is selected, otherwise every shape of the active label.
   * Closed+filled shapes fill their interior; others are stroked at the current
   * brush width.
   */
  rasterize(): void {
    const shapes = this.shapesToRasterize();
    if (shapes.length === 0) return;

    const w = this.state.width;
    const h = this.state.height;
    const labels = this.labels.listSegmentationLabels;
    const ctx = this.canvasManager.getBufferCtx();
    const instanceMode = this.project.isInstanceSegmentation();

    const touched = new Set<number>();
    const burned: string[] = [];
    // Per-layer running instance id so multiple shapes on an instance label get
    // distinct ids (semantic labels always write 1).
    const nextId = new Map<number, number>();

    for (const shape of shapes) {
      const li = labels.findIndex((l) => l.id === shape.labelId);
      if (li < 0) continue;
      const mask = this.canvasManager.getAllMasks()[li];
      if (!mask) continue;

      const rect = this.burnShape(ctx, shape, w, h);
      if (!rect) continue;

      let value = 1;
      if (instanceMode) {
        let id = nextId.get(li);
        if (id === undefined) id = this.maxValue(mask) + 1;
        value = Math.min(255, id);
        nextId.set(li, id + 1);
      }

      const region = ctx.getImageData(rect.x, rect.y, rect.width, rect.height).data;
      commitStroke(mask, w, region, rect, value);
      touched.add(li);
      burned.push(shape.id);
    }

    // Leave the scratch buffer clean so it can't bleed into a later stroke.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.restore();

    if (touched.size === 0) return;

    this.undoRedo.beginGroup();
    this.undoRedo.snapshotLayers([...touched]); // raster snapshot
    this.vectorEditor.deleteShapesByIds(burned); // vector commit
    this.undoRedo.endGroup();

    this.refresh();
  }

  private shapesToRasterize(): VectorShape[] {
    // Rasterize every selected path (across labels — each burns into its own
    // label's mask). With nothing selected, fall back to the active label's
    // shapes so the toolbar button still does the expected thing.
    const selected = this.vectorEditor.selectedShapes();
    if (selected.length > 0) return selected;
    const activeId = this.labels.activeLabel?.id;
    if (activeId == null) return [];
    return this.vectorEditor.shapes().filter((s) => s.labelId === activeId);
  }

  /**
   * Rasterize one shape onto the scratch buffer (white on transparent) and
   * return the clamped bbox of the affected pixels, or null if it collapses.
   */
  private burnShape(
    ctx: OffscreenCanvasRenderingContext2D,
    shape: VectorShape,
    w: number,
    h: number,
  ): Rect | null {
    const bounds = shapeBounds(shape);
    if (!bounds) return null;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const path = new Path2D(buildPathData(shape));
    const filled = shape.closed && shape.filled;
    let pad: number;
    if (filled) {
      ctx.fillStyle = '#ffffff';
      ctx.fill(path);
      pad = 1;
    } else {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, this.editor.lineWidth);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(path);
      pad = Math.ceil(ctx.lineWidth / 2) + 1;
    }
    ctx.restore();

    return intRect(
      {
        x: bounds.x - pad,
        y: bounds.y - pad,
        width: bounds.width + 2 * pad,
        height: bounds.height + 2 * pad,
      },
      w,
      h,
    );
  }

  private maxValue(mask: Uint8Array): number {
    let max = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] > max) max = mask[i];
    return max;
  }

  // ── Vectorize (raster → vector) ─────────────────────────────────────────────

  /**
   * Trace the connected component of the active label's mask under `pixel` into
   * a closed filled shape, then clear those pixels. No-op when the click lands
   * on background.
   */
  async vectorizeAt(pixel: Pt): Promise<void> {
    const w = this.state.width;
    const h = this.state.height;
    const x = Math.floor(pixel.x);
    const y = Math.floor(pixel.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;

    const li = this.canvasManager.getActiveIndex();
    const mask = this.canvasManager.getAllMasks()[li];
    const label = this.labels.listSegmentationLabels[li];
    if (!mask || !label || mask[y * w + x] === 0) return;

    let polygons: number[][][];
    try {
      polygons = await api.vectorizeComponent(mask, w, h, x, y);
    } catch (error) {
      console.error('vectorize failed:', error);
      return;
    }
    // The mask may have changed while awaiting; re-check the seed pixel.
    if (polygons.length === 0 || mask[y * w + x] === 0) return;

    const shapes = polygons
      .filter((poly) => poly.length >= 3)
      .map((poly) => this.polygonToShape(poly, label.id));
    if (shapes.length === 0) return;

    clearValueComponentAt(mask, w, h, x, y);

    this.undoRedo.beginGroup();
    this.undoRedo.snapshotLayers([li]); // raster snapshot (pixels cleared)
    this.vectorEditor.addShapes(shapes); // vector commit
    this.undoRedo.endGroup();

    this.refresh();
  }

  private polygonToShape(poly: number[][], labelId: number): VectorShape {
    return {
      id: crypto.randomUUID(),
      labelId,
      closed: true,
      filled: true,
      nodes: poly.map(([px, py]) => makeNode(px, py, false)),
    };
  }

  // ── Skeletonize (raster → open centerline paths) ────────────────────────────

  /**
   * Thin the connected component of the active label's mask under `pixel` into
   * its 1px skeleton, split at endpoints/junctions, and add each branch as an
   * open path; then clear those pixels. No-op on background.
   */
  async skeletonizeAt(pixel: Pt): Promise<void> {
    const w = this.state.width;
    const h = this.state.height;
    const x = Math.floor(pixel.x);
    const y = Math.floor(pixel.y);
    if (x < 0 || y < 0 || x >= w || y >= h) return;

    const li = this.canvasManager.getActiveIndex();
    const mask = this.canvasManager.getAllMasks()[li];
    const label = this.labels.listSegmentationLabels[li];
    if (!mask || !label || mask[y * w + x] === 0) return;

    let polylines: number[][][];
    try {
      polylines = await api.skeletonizeComponent(mask, w, h, x, y);
    } catch (error) {
      console.error('skeletonize failed:', error);
      return;
    }
    // The mask may have changed while awaiting; re-check the seed pixel.
    if (polylines.length === 0 || mask[y * w + x] === 0) return;

    const shapes = polylines
      .filter((poly) => poly.length >= 2)
      .map((poly) => this.polylineToShape(poly, label.id));
    if (shapes.length === 0) return;

    clearValueComponentAt(mask, w, h, x, y);

    this.undoRedo.beginGroup();
    this.undoRedo.snapshotLayers([li]); // raster snapshot (pixels cleared)
    this.vectorEditor.addShapes(shapes); // vector commit
    this.undoRedo.endGroup();

    this.refresh();
  }

  private polylineToShape(poly: number[][], labelId: number): VectorShape {
    return {
      id: crypto.randomUUID(),
      labelId,
      closed: false,
      filled: false,
      nodes: poly.map(([px, py]) => makeNode(px, py, false)),
    };
  }

  // ── Shared ──────────────────────────────────────────────────────────────────

  /** Recompute the composite, redraw the display, and mark the frame dirty. */
  private refresh(): void {
    this.state.recomputeCanvasSum = true;
    this.canvasManager.requestRedraw.next(true);
    this.io.markDirty();
  }
}
