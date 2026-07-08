import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { ZoomPanService } from './zoom-pan.service';
import { Tools } from '../../../../../Core/tools';
import {
  Bounds,
  Pt,
  VectorNode,
  VectorShape,
  boundsIntersect,
  closestSegment,
  distance,
  distanceToShape,
  isFlatHandle,
  makeNode,
  pointInShape,
  shapeBounds,
  splitSegment,
  translateShape,
} from '../vector/vector.model';

/** Screen-pixel pick radius for nodes/handles/paths and the close-path target. */
const HIT_PX = 9;

/** Image-px offset applied to pasted/duplicated shapes so the copy is visible. */
const PASTE_OFFSET = 12;

type HandleSide = 'in' | 'out';

/** Modifier state captured at pointer-down for the Select tool. */
export interface SelectMods {
  /** Shift: additive marquee / add-to-selection. */
  shift: boolean;
  /** Ctrl/Cmd: toggle a shape's membership. */
  toggle: boolean;
}

/** A shape's bounding box for the overlay (label colour resolved at render). */
export interface VectorBoundingBox {
  shapeId: string;
  labelId: number;
  rect: Bounds;
}

/**
 * Owns the vector shapes for the current frame plus the Pen (create) and Node
 * (edit/select) interaction state machines. The drawable-canvas routes pointer
 * input here when a vector tool is active; the vector layer renders the state.
 *
 * No dependency on IOService: it emits `changed$` after a committed mutation and
 * IOService subscribes to mark the frame dirty (one-directional, no DI cycle).
 */
@Injectable({ providedIn: 'root' })
export class VectorEditorService {
  private readonly editor = inject(EditorService);
  private readonly labels = inject(LabelsService);
  private readonly zoomPan = inject(ZoomPanService);

  // ── Committed shapes (current frame) ──────────────────────────────────────
  private readonly _shapes = signal<VectorShape[]>([]);
  readonly shapes = this._shapes.asReadonly();
  readonly hasShapes = computed(() => this._shapes().length > 0);

  // ── In-progress Pen draft ─────────────────────────────────────────────────
  private readonly _draft = signal<VectorShape | null>(null);
  readonly draft = this._draft.asReadonly();
  /** Rubber-band cursor position while a draft awaits its next node. */
  private readonly _hover = signal<Pt | null>(null);
  readonly hover = this._hover.asReadonly();

  // ── Selection ─────────────────────────────────────────────────────────────
  // Object-level selection is a set of shape ids (Select tool: one or many).
  // Node-level editing (Node tool) only applies when exactly one is selected.
  private readonly _selectedIds = signal<string[]>([]);
  readonly selectedIds = this._selectedIds.asReadonly();
  private readonly _selectedNode = signal<number | null>(null);
  readonly selectedNodeIndex = this._selectedNode.asReadonly();

  /** The single selected shape, or null when zero/many are selected. Keeps the
   *  Node tool and properties panel single-shape (unchanged behavior). */
  readonly selectedShape = computed(() => {
    const ids = this._selectedIds();
    if (ids.length !== 1) return null;
    return this._shapes().find((s) => s.id === ids[0]) ?? null;
  });

  /** Every currently selected shape (Select tool group operations). */
  readonly selectedShapes = computed(() => {
    const set = new Set(this._selectedIds());
    return this._shapes().filter((s) => set.has(s.id));
  });

  // ── Select-tool marquee (rubber-band) rectangle, in image space ───────────
  private readonly _marquee = signal<Bounds | null>(null);
  readonly marquee = this._marquee.asReadonly();

  /** One bounding box per shape, for the bbox overlay. Recomputes only when the
   *  shapes change; label visibility/colour are resolved at render time. */
  readonly boundingBoxes = computed<VectorBoundingBox[]>(() => {
    const boxes: VectorBoundingBox[] = [];
    for (const shape of this._shapes()) {
      const rect = shapeBounds(shape);
      if (rect) boxes.push({ shapeId: shape.id, labelId: shape.labelId, rect });
    }
    return boxes;
  });

  /** Fires whenever the shapes change in a way that should be saved (commit,
   *  undo and redo) — IOService subscribes to mark the frame dirty. */
  readonly changed$ = new Subject<void>();
  /** Fires only on a NEW committed action (not undo/redo) — the unified history
   *  coordinator subscribes to record a 'vector' entry in the action order. */
  readonly committed$ = new Subject<void>();

  // Vector-only undo/redo history (snapshots of the shapes array). The baseline
  // (index 0) is the loaded state; undo never pops past it.
  private undoStack: VectorShape[][] = [[]];
  private redoStack: VectorShape[][] = [];

  // ── Transient drag state (plain fields, not reactive) ─────────────────────
  private pointerDown = false;
  private penHandleNode: number | null = null; // node whose handle a Pen drag sets
  private nodeDrag: { nodeIndex: number } | null = null;
  private handleDrag: { nodeIndex: number; side: HandleSide } | null = null;
  // Select tool: dragging a selected path's body moves the whole selection.
  private groupDrag: {
    last: Pt;
    moved: boolean;
    clickedId: string;
    wasSelected: boolean;
  } | null = null;
  // Select tool: rubber-band box drag over empty canvas.
  private marqueeDrag: { origin: Pt; base: string[]; additive: boolean; moved: boolean } | null =
    null;

  // Cross-frame copy buffer. Deliberately NOT reset by setShapes()/clear() so a
  // shape copied on one frame can be pasted onto another frame or sequence.
  private clipboard: VectorShape[] = [];

  constructor() {
    // Leaving Path mode auto-validates the in-progress draft, so switching to
    // the Node tool (toolbar or keyboard) doesn't strand an uncommitted path.
    // A transient pan (space/middle-click) is excluded so it doesn't finalize.
    this.editor.toolChanged$.subscribe((tool) => {
      if (this._draft() && tool !== Tools.PATH && tool !== Tools.PAN) {
        this.finalizeDraft(false, false);
      }
    });
  }

  // ── Frame lifecycle (called by IOService) ─────────────────────────────────

  /** Replace the whole set (on frame load). Resets interaction + history. */
  setShapes(shapes: VectorShape[]): void {
    this._shapes.set(shapes);
    this.resetInteraction();
    this.undoStack = [this.cloneShapes(shapes)];
    this.redoStack = [];
  }

  clear(): void {
    this._shapes.set([]);
    this.resetInteraction();
    this.undoStack = [[]];
    this.redoStack = [];
  }

  private resetInteraction(): void {
    this._draft.set(null);
    this._hover.set(null);
    this._selectedIds.set([]);
    this._selectedNode.set(null);
    this._marquee.set(null);
    this.pointerDown = false;
    this.penHandleNode = null;
    this.nodeDrag = null;
    this.handleDrag = null;
    this.groupDrag = null;
    this.marqueeDrag = null;
    // NB: clipboard is intentionally preserved across frames (cross-frame paste).
  }

  shapesByLabel(): Map<number, VectorShape[]> {
    const byLabel = new Map<number, VectorShape[]>();
    for (const shape of this._shapes()) {
      const list = byLabel.get(shape.labelId);
      if (list) list.push(shape);
      else byLabel.set(shape.labelId, [shape]);
    }
    return byLabel;
  }

  // ── Pointer input (image-space coords) ────────────────────────────────────

  onPointerDown(p: Pt, mods: SelectMods = { shift: false, toggle: false }): void {
    this.pointerDown = true;
    if (this.editor.isPathTool()) this.penDown(p);
    else if (this.editor.isNodeTool()) this.nodeDown(p);
    else if (this.editor.isSelectTool()) this.selectDown(p, mods);
  }

  onPointerMove(p: Pt): void {
    if (this.editor.isPathTool()) this.penMove(p);
    else if (this.editor.isNodeTool()) this.nodeMove(p);
    else if (this.editor.isSelectTool()) this.selectMove(p);
  }

  onPointerUp(): void {
    if (this.editor.isNodeTool() && (this.nodeDrag || this.handleDrag)) {
      this.commit(); // commit a node/handle drag once, at the end
    } else if (this.editor.isSelectTool()) {
      this.selectUp();
    }
    this.pointerDown = false;
    this.penHandleNode = null;
    this.nodeDrag = null;
    this.handleDrag = null;
  }

  /**
   * Double-click. With the Select tool, entering a path opens it for node
   * editing (select it + switch to the Node tool). With the Node tool: on a
   * node, toggle its smoothness (generating handles for a corner that has
   * none); on a path, insert a new node at the click position.
   */
  onDoubleClick(p: Pt): void {
    if (this.editor.isSelectTool()) {
      const hit = this.pickSelectable(p, this.tol());
      if (hit) {
        this.selectOnly(hit.id);
        this.editor.selectTool(Tools.NODE);
      }
      return;
    }
    if (!this.editor.isNodeTool()) return;
    const tol = this.tol();
    const sel = this.selectedShape();

    if (sel) {
      for (let i = 0; i < sel.nodes.length; i++) {
        if (distance(p, sel.nodes[i]) < tol) {
          this.toggleNodeSmooth(sel.id, i);
          this._selectedNode.set(i);
          return;
        }
      }
    }

    // Insert on the selected shape if the click is on it, else the nearest shape.
    const target =
      sel && distanceToShape(sel, p) <= tol ? sel : this.pickShape(p, tol);
    if (!target) return;

    const seg = closestSegment(target, p);
    if (!seg) return;
    this._shapes.update((list) =>
      list.map((s) =>
        s.id === target.id ? splitSegment(s, seg.segIndex, seg.t) : s,
      ),
    );
    this.selectOnly(target.id);
    this._selectedNode.set(seg.segIndex + 1);
    this.commit();
  }

  // ── Keyboard ──────────────────────────────────────────────────────────────

  /** Finish the current draft as an open path. */
  finishDraft(): void {
    if (this._draft()) this.finalizeDraft(false);
  }

  /** Esc: cancel an in-progress draft, otherwise clear the selection. */
  cancel(): void {
    if (this._draft()) {
      this._draft.set(null);
      this._hover.set(null);
      this.penHandleNode = null;
      return;
    }
    this._selectedIds.set([]);
    this._selectedNode.set(null);
    this._marquee.set(null);
    this.groupDrag = null;
    this.marqueeDrag = null;
  }

  /**
   * Delete the current selection. With several shapes selected, remove them all;
   * with one, delete its targeted node (Node tool) or the whole shape.
   */
  deleteSelection(): void {
    if (this._draft()) return;
    const ids = this._selectedIds();
    if (ids.length > 1) {
      this.deleteShapesByIds([...ids]);
      return;
    }
    const shape = this.selectedShape();
    if (!shape) return;
    const ni = this._selectedNode();
    if (ni !== null) this.deleteNode(shape.id, ni);
    else this.deleteShape(shape.id);
  }

  // ── Selected-shape property actions (properties panel) ────────────────────

  deleteSelectedShape(): void {
    const shape = this.selectedShape();
    if (shape) this.deleteShape(shape.id);
  }

  /** Reassign the selected shape to a different label layer (the vector
   *  equivalent of swapping a raster region to another label). */
  moveSelectedToLabel(labelId: number): void {
    if (this.labels.listSegmentationLabels.some((l) => l.id === labelId)) {
      this.mutateSelected((s) => ({ ...s, labelId }));
    }
  }

  /** Delete a shape by id (e.g. an erase-on-click on its bounding box). */
  deleteShapeById(id: string): void {
    if (this._shapes().some((s) => s.id === id)) this.deleteShape(id);
  }

  /** Remove several shapes in a single committed action (e.g. rasterize). */
  deleteShapesByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const remove = new Set(ids);
    if (!this._shapes().some((s) => remove.has(s.id))) return;
    this._shapes.update((list) => list.filter((s) => !remove.has(s.id)));
    this._selectedIds.set([]);
    this._selectedNode.set(null);
    this.commit();
  }

  /** Append shapes in a single committed action (e.g. vectorize). Selects the
   *  first added shape so it can be tweaked immediately with the Node tool. */
  addShapes(shapes: VectorShape[]): void {
    if (shapes.length === 0) return;
    this._shapes.update((list) => [...list, ...shapes]);
    this.selectOnly(shapes[0].id);
    this.commit();
  }

  toggleFilled(): void {
    this.mutateSelected((s) => ({ ...s, filled: s.closed ? !s.filled : false }));
  }

  toggleClosed(): void {
    this.mutateSelected((s) => ({ ...s, closed: !s.closed }));
  }

  // ── Pen tool ──────────────────────────────────────────────────────────────

  private penDown(p: Pt): void {
    const draft = this._draft();

    if (!draft) {
      const labelId = this.labels.activeLabel?.id;
      if (labelId == null) return; // need an active label to own the shape
      this._draft.set({
        id: crypto.randomUUID(),
        labelId,
        closed: false,
        filled: false,
        nodes: [makeNode(p.x, p.y)],
      });
      this.penHandleNode = 0;
      return;
    }

    // Click the first node (with ≥2 nodes placed) closes the path.
    if (draft.nodes.length >= 2 && distance(p, draft.nodes[0]) < this.tol()) {
      this.finalizeDraft(true);
      return;
    }

    const nodes = [...draft.nodes, makeNode(p.x, p.y)];
    this._draft.set({ ...draft, nodes });
    this.penHandleNode = nodes.length - 1;
  }

  private penMove(p: Pt): void {
    const draft = this._draft();
    if (!draft) return;

    if (this.pointerDown && this.penHandleNode !== null) {
      // Dragging out from a just-placed node sets a symmetric smooth handle.
      const i = this.penHandleNode;
      const nodes = draft.nodes.map((nd, idx) =>
        idx === i ? this.withSmoothHandle(nd, p) : nd,
      );
      this._draft.set({ ...draft, nodes });
    } else {
      this._hover.set(p); // rubber-band preview toward the cursor
    }
  }

  private withSmoothHandle(node: VectorShape['nodes'][number], handle: Pt) {
    return {
      ...node,
      outX: handle.x,
      outY: handle.y,
      inX: 2 * node.x - handle.x,
      inY: 2 * node.y - handle.y,
      smooth: true,
    };
  }

  private finalizeDraft(closed: boolean, handoffToNode = false): void {
    const draft = this._draft();
    if (!draft) return;

    // A path needs at least two nodes to be meaningful.
    if (draft.nodes.length < 2) {
      this._draft.set(null);
      this._hover.set(null);
      this.penHandleNode = null;
      return;
    }

    const shape: VectorShape = {
      ...draft,
      closed,
      filled: closed ? draft.filled : false,
    };
    this._shapes.update((list) => [...list, shape]);
    this._draft.set(null);
    this._hover.set(null);
    this.penHandleNode = null;
    this.commit();

    // Select the new shape; optionally hand off to the Node tool for tweaking
    // (skipped when finalizing because the user already switched tools).
    this.selectOnly(shape.id);
    if (handoffToNode) this.editor.selectTool(Tools.NODE);
  }

  // ── Node tool ─────────────────────────────────────────────────────────────

  private nodeDown(p: Pt): void {
    const tol = this.tol();
    const current = this.selectedShape();
    // A hidden shape can't be seen, so don't let its nodes be grabbed.
    const sel = current && this.isLabelVisible(current.labelId) ? current : null;

    // Prefer grabbing the selected shape's handles, then its anchors.
    if (sel) {
      for (let i = 0; i < sel.nodes.length; i++) {
        const nd = sel.nodes[i];
        if (
          !isFlatHandle(nd.x, nd.y, nd.outX, nd.outY) &&
          distance(p, { x: nd.outX, y: nd.outY }) < tol
        ) {
          this.handleDrag = { nodeIndex: i, side: 'out' };
          this._selectedNode.set(i);
          return;
        }
        if (
          !isFlatHandle(nd.x, nd.y, nd.inX, nd.inY) &&
          distance(p, { x: nd.inX, y: nd.inY }) < tol
        ) {
          this.handleDrag = { nodeIndex: i, side: 'in' };
          this._selectedNode.set(i);
          return;
        }
      }
      for (let i = 0; i < sel.nodes.length; i++) {
        if (distance(p, sel.nodes[i]) < tol) {
          this.nodeDrag = { nodeIndex: i };
          this._selectedNode.set(i);
          return;
        }
      }
    }

    // Otherwise pick the closest shape whose outline is within tolerance.
    const hit = this.pickShape(p, tol);
    this.selectOnly(hit?.id ?? null);
  }

  private nodeMove(p: Pt): void {
    if (this.nodeDrag) {
      const { nodeIndex } = this.nodeDrag;
      this.mutateSelectedLive((s) => {
        const nd = s.nodes[nodeIndex];
        const dx = p.x - nd.x;
        const dy = p.y - nd.y;
        const moved = {
          ...nd,
          x: p.x,
          y: p.y,
          inX: nd.inX + dx,
          inY: nd.inY + dy,
          outX: nd.outX + dx,
          outY: nd.outY + dy,
        };
        return { ...s, nodes: s.nodes.map((n, i) => (i === nodeIndex ? moved : n)) };
      });
    } else if (this.handleDrag) {
      const { nodeIndex, side } = this.handleDrag;
      this.mutateSelectedLive((s) => {
        const nd = s.nodes[nodeIndex];
        let moved = { ...nd };
        if (side === 'out') {
          moved.outX = p.x;
          moved.outY = p.y;
          if (nd.smooth) {
            moved.inX = 2 * nd.x - p.x;
            moved.inY = 2 * nd.y - p.y;
          }
        } else {
          moved.inX = p.x;
          moved.inY = p.y;
          if (nd.smooth) {
            moved.outX = 2 * nd.x - p.x;
            moved.outY = 2 * nd.y - p.y;
          }
        }
        return { ...s, nodes: s.nodes.map((n, i) => (i === nodeIndex ? moved : n)) };
      });
    }
  }

  private pickShape(p: Pt, tol: number): VectorShape | null {
    let best: VectorShape | null = null;
    let bestDist = tol;
    for (const shape of this._shapes()) {
      if (!this.isLabelVisible(shape.labelId)) continue; // can't pick hidden shapes
      const d = distanceToShape(shape, p);
      if (d <= bestDist) {
        bestDist = d;
        best = shape;
      }
    }
    return best;
  }

  private isLabelVisible(labelId: number): boolean {
    const label = this.labels.listSegmentationLabels.find((l) => l.id === labelId);
    return label?.isVisible ?? true;
  }

  // ── Select tool (object-level pick / marquee / move) ──────────────────────

  private selectDown(p: Pt, mods: SelectMods): void {
    const hit = this.pickSelectable(p, this.tol());

    if (hit) {
      if (mods.toggle) {
        this.toggleInSelection(hit.id);
        return; // a toggle-click doesn't start a move
      }
      const already = this.isSelected(hit.id);
      if (!already) {
        if (mods.shift) this.addToSelection(hit.id);
        else this.selectOnly(hit.id);
      }
      // Arm a group move over the current selection.
      this.groupDrag = { last: p, moved: false, clickedId: hit.id, wasSelected: already };
      return;
    }

    // Empty canvas: begin a marquee (clearing first unless additive).
    const base = mods.shift ? [...this._selectedIds()] : [];
    if (!mods.shift) this._selectedIds.set([]);
    this._selectedNode.set(null);
    this.marqueeDrag = { origin: p, base, additive: mods.shift, moved: false };
    this._marquee.set({ x: p.x, y: p.y, width: 0, height: 0 });
  }

  private selectMove(p: Pt): void {
    if (this.groupDrag) {
      const dx = p.x - this.groupDrag.last.x;
      const dy = p.y - this.groupDrag.last.y;
      if (dx !== 0 || dy !== 0) {
        this.translateSelection(dx, dy);
        this.groupDrag.last = p;
        this.groupDrag.moved = true;
      }
    } else if (this.marqueeDrag) {
      const o = this.marqueeDrag.origin;
      this.marqueeDrag.moved = true;
      this._marquee.set({
        x: Math.min(o.x, p.x),
        y: Math.min(o.y, p.y),
        width: Math.abs(p.x - o.x),
        height: Math.abs(p.y - o.y),
      });
    }
  }

  private selectUp(): void {
    if (this.groupDrag) {
      if (this.groupDrag.moved) {
        this.commit(); // one undoable step for the whole move
      } else if (this.groupDrag.wasSelected && this._selectedIds().length > 1) {
        // A plain click on an already-multiselected shape collapses to just it.
        this.selectOnly(this.groupDrag.clickedId);
      }
      this.groupDrag = null;
    } else if (this.marqueeDrag) {
      const rect = this._marquee();
      // Only a real drag box-selects; a click (no move) just deselected above.
      if (rect && this.marqueeDrag.moved) {
        this.applyMarquee(rect, this.marqueeDrag.base, this.marqueeDrag.additive);
      }
      this._marquee.set(null);
      this.marqueeDrag = null;
    }
  }

  /** Topmost visible shape under p: a closed body hit wins, else nearest outline. */
  private pickSelectable(p: Pt, tol: number): VectorShape | null {
    const shapes = this._shapes();
    let best: VectorShape | null = null;
    let bestDist = tol;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (!this.isLabelVisible(s.labelId)) continue;
      if (pointInShape(s, p)) return s;
      const d = distanceToShape(s, p);
      if (d <= bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return best;
  }

  /** Translate every selected shape by (dx, dy) in image space (live, no commit). */
  private translateSelection(dx: number, dy: number): void {
    const ids = new Set(this._selectedIds());
    if (ids.size === 0) return;
    this._shapes.update((list) =>
      list.map((s) => (ids.has(s.id) ? translateShape(s, dx, dy) : s)),
    );
  }

  /** Select shapes whose bbox intersects the marquee (union with base if additive). */
  private applyMarquee(rect: Bounds, base: string[], additive: boolean): void {
    const ids = new Set<string>(additive ? base : []);
    for (const s of this._shapes()) {
      if (!this.isLabelVisible(s.labelId)) continue;
      const b = shapeBounds(s);
      if (b && boundsIntersect(b, rect)) ids.add(s.id);
    }
    this._selectedIds.set([...ids]);
    this._selectedNode.set(null);
  }

  // ── Copy / paste / duplicate (cross-frame) ────────────────────────────────

  /** Copy the current selection into the (frame-independent) clipboard. */
  copySelection(): void {
    const sel = this.selectedShapes();
    if (sel.length === 0) return;
    this.clipboard = sel.map((s) => this.cloneShape(s));
  }

  /** Paste the clipboard into the current frame (fresh ids, offset, selected). */
  pasteClipboard(): void {
    if (this.clipboard.length === 0) return;
    this.addCopies(this.clipboard);
  }

  /** Duplicate the current selection in place (fresh ids, offset, selected). */
  duplicateSelection(): void {
    const sel = this.selectedShapes();
    if (sel.length === 0) return;
    this.addCopies(sel);
  }

  /** Select every shape on the current frame (skipping hidden labels). */
  selectAll(): void {
    const ids = this._shapes()
      .filter((s) => this.isLabelVisible(s.labelId))
      .map((s) => s.id);
    this._selectedIds.set(ids);
    this._selectedNode.set(null);
  }

  /** Materialize copies of `sources` into the frame as one committed action. */
  private addCopies(sources: VectorShape[]): void {
    const copies = sources.map((s) => this.materializeCopy(s));
    if (copies.length === 0) return;
    this._shapes.update((list) => [...list, ...copies]);
    this._selectedIds.set(copies.map((s) => s.id));
    this._selectedNode.set(null);
    this.commit();
  }

  /** A fresh-id, offset clone; remaps a missing label to the active one. */
  private materializeCopy(s: VectorShape): VectorShape {
    const labelId = this.labels.listSegmentationLabels.some((l) => l.id === s.labelId)
      ? s.labelId
      : this.labels.activeLabel?.id ?? s.labelId;
    const moved = translateShape(this.cloneShape(s), PASTE_OFFSET, PASTE_OFFSET);
    return { ...moved, id: crypto.randomUUID(), labelId };
  }

  private cloneShape(s: VectorShape): VectorShape {
    return { ...s, nodes: s.nodes.map((n) => ({ ...n })) };
  }

  // ── Selection helpers ─────────────────────────────────────────────────────

  private isSelected(id: string): boolean {
    return this._selectedIds().includes(id);
  }

  private selectOnly(id: string | null): void {
    this._selectedIds.set(id ? [id] : []);
    this._selectedNode.set(null);
  }

  private addToSelection(id: string): void {
    if (!this.isSelected(id)) this._selectedIds.update((l) => [...l, id]);
  }

  private toggleInSelection(id: string): void {
    this._selectedIds.update((l) =>
      l.includes(id) ? l.filter((x) => x !== id) : [...l, id],
    );
    this._selectedNode.set(null);
  }

  /** The single selected id, or null when zero/many are selected. */
  private primaryId(): string | null {
    const ids = this._selectedIds();
    return ids.length === 1 ? ids[0] : null;
  }

  // ── Shape mutations ───────────────────────────────────────────────────────

  private deleteNode(shapeId: string, index: number): void {
    const shape = this._shapes().find((s) => s.id === shapeId);
    if (!shape) return;

    // Fewer than 2 remaining nodes is not a path — drop the whole shape.
    if (shape.nodes.length <= 2) {
      this.deleteShape(shapeId);
      return;
    }
    this._shapes.update((list) =>
      list.map((s) =>
        s.id === shapeId
          ? { ...s, nodes: s.nodes.filter((_, i) => i !== index) }
          : s,
      ),
    );
    this._selectedNode.set(null);
    this.commit();
  }

  private deleteShape(shapeId: string): void {
    this._shapes.update((list) => list.filter((s) => s.id !== shapeId));
    this.selectOnly(null);
    this.commit();
  }

  /** Apply a transform to the single selected shape and commit (marks dirty). */
  private mutateSelected(fn: (s: VectorShape) => VectorShape): void {
    const id = this.primaryId();
    if (!id) return;
    this._shapes.update((list) =>
      list.map((s) => (s.id === id ? fn(s) : s)),
    );
    this.commit();
  }

  /** Like mutateSelected but for live drag updates — does NOT mark dirty. */
  private mutateSelectedLive(fn: (s: VectorShape) => VectorShape): void {
    const id = this.primaryId();
    if (!id) return;
    this._shapes.update((list) =>
      list.map((s) => (s.id === id ? fn(s) : s)),
    );
  }

  /**
   * Flip a node between smooth and corner. A corner with no handles gains
   * tangent handles derived from its neighbours; a smooth node collapses its
   * handles back onto the anchor.
   */
  private toggleNodeSmooth(shapeId: string, index: number): void {
    const shape = this._shapes().find((s) => s.id === shapeId);
    if (!shape) return;
    const node = shape.nodes[index];
    const flat =
      isFlatHandle(node.x, node.y, node.inX, node.inY) &&
      isFlatHandle(node.x, node.y, node.outX, node.outY);

    const updated = flat
      ? this.autoSmooth(shape, index)
      : { ...node, inX: node.x, inY: node.y, outX: node.x, outY: node.y, smooth: false };

    this._shapes.update((list) =>
      list.map((s) =>
        s.id === shapeId
          ? { ...s, nodes: s.nodes.map((n, i) => (i === index ? updated : n)) }
          : s,
      ),
    );
    this.commit();
  }

  /** Generate symmetric handles for a node, tangent to its neighbours. */
  private autoSmooth(shape: VectorShape, index: number): VectorNode {
    const node = shape.nodes[index];
    const prev = this.neighbor(shape, index, -1);
    const next = this.neighbor(shape, index, 1);

    let tx: number;
    let ty: number;
    if (prev && next) {
      tx = next.x - prev.x;
      ty = next.y - prev.y;
    } else if (next) {
      tx = next.x - node.x;
      ty = next.y - node.y;
    } else if (prev) {
      tx = node.x - prev.x;
      ty = node.y - prev.y;
    } else {
      tx = 1;
      ty = 0;
    }
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;

    const dNext = next ? distance(node, next) / 3 : 0;
    const dPrev = prev ? distance(node, prev) / 3 : 0;

    return {
      ...node,
      smooth: true,
      outX: node.x + tx * dNext,
      outY: node.y + ty * dNext,
      inX: node.x - tx * dPrev,
      inY: node.y - ty * dPrev,
    };
  }

  /** Neighbour anchor in a direction, wrapping for closed paths. */
  private neighbor(shape: VectorShape, index: number, dir: number): Pt | null {
    const len = shape.nodes.length;
    if (shape.closed) {
      const j = ((index + dir) % len + len) % len;
      return { x: shape.nodes[j].x, y: shape.nodes[j].y };
    }
    const j = index + dir;
    if (j < 0 || j >= len) return null;
    return { x: shape.nodes[j].x, y: shape.nodes[j].y };
  }

  // ── Undo / redo ───────────────────────────────────────────────────────────

  canUndo(): boolean {
    return this.undoStack.length > 1;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Step back one committed change. Returns false if at the baseline. */
  undo(): boolean {
    if (this.undoStack.length <= 1) return false;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    this.restore(this.undoStack[this.undoStack.length - 1]);
    return true;
  }

  /** Re-apply a previously undone change. Returns false if none. */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(next);
    this.restore(next);
    return true;
  }

  /** Snapshot the new state and signal a fresh committed action. */
  private commit(): void {
    this.undoStack.push(this.cloneShapes(this._shapes()));
    this.redoStack = [];
    this.committed$.next(); // record a 'vector' entry in the unified order
    this.changed$.next(); // mark dirty
  }

  /** Deep clone of the shape data (all fields are primitives). */
  private cloneShapes(shapes: VectorShape[]): VectorShape[] {
    return shapes.map((s) => ({ ...s, nodes: s.nodes.map((n) => ({ ...n })) }));
  }

  private restore(state: VectorShape[]): void {
    this._shapes.set(this.cloneShapes(state));
    // Heal selection references that the restored state no longer contains
    // (drop ids of deleted shapes; keep a multi-selection otherwise).
    const existing = new Set(this._shapes().map((s) => s.id));
    this._selectedIds.update((ids) => ids.filter((id) => existing.has(id)));
    const sel = this.selectedShape();
    const ni = this._selectedNode();
    if (!sel || (ni !== null && ni >= sel.nodes.length)) this._selectedNode.set(null);
    this.changed$.next(); // mark dirty, but NOT committed$ (not a new action)
  }

  private tol(): number {
    return HIT_PX / Math.max(1e-6, this.zoomPan.scale);
  }
}
