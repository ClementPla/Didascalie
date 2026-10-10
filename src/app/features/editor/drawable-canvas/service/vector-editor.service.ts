import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../services/labels/labels.service';
import { ZoomPanService } from './zoom-pan.service';
import { Tools } from '../../../../core/tools';
import {
  Bounds,
  Pt,
  SideHandle,
  VectorNode,
  VectorShape,
  boundsIntersect,
  cloneShape,
  cloneShapes,
  closestSegment,
  distance,
  distanceToShape,
  ellipseNodes,
  isFlatHandle,
  makeNode,
  pointInShape,
  rectNodes,
  rotateShape,
  shapeBounds,
  shapesBounds,
  sideHandles,
  splitSegment,
  stretchShape,
  translateShape,
} from '../vector/vector.model';
import { VectorHistory } from '../vector/vector-history';
import { ProjectScoped } from '../../../../core/project-scoped';

/** Pick radius, in screen px. */
const HIT_PX = 9;

/** Offset of pasted and duplicated shapes, in image px. */
const PASTE_OFFSET = 12;

/** Distance from the gizmo's pivot to its rotation knob, in screen px. */
const GIZMO_ARM_PX = 38;

/** Rotation step while Shift is held. */
const ROTATE_SNAP = Math.PI / 12;

/** Below this size, in screen px, a Box/Ellipse drag is a click. */
const MIN_SHAPE_PX = 3;

type HandleSide = 'in' | 'out';

export interface SelectMods {
  /** Shift: add to the selection; square or circle while dragging out a
   *  shape; 15° steps while rotating. */
  shift: boolean;
  /** Ctrl/Cmd: toggle a shape's selection; drag a shape out from its centre. */
  toggle: boolean;
}

/** The gizmo drawn over the selection (image space): drag the pivot to move,
 *  the knob to rotate. */
export interface VectorGizmo {
  pivot: Pt;
  knob: Pt;
  /** Rotation applied by the drag in progress, in radians (0 when idle). */
  angle: number;
  rotating: boolean;
}

export interface VectorBoundingBox {
  shapeId: string;
  labelId: number;
  rect: Bounds;
}

/**
 * The vector shapes of the current frame, and the state machines of the
 * vector tools. Emits `changed$` after a committed mutation; IOService
 * subscribes to it (this service does not depend on IOService).
 */
@Injectable({ providedIn: 'root' })
export class VectorEditorService implements ProjectScoped {
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
  // A set of shape ids. Node editing applies when exactly one is selected.
  private readonly _selectedIds = signal<string[]>([]);
  readonly selectedIds = this._selectedIds.asReadonly();
  private readonly _selectedNode = signal<number | null>(null);
  readonly selectedNodeIndex = this._selectedNode.asReadonly();

  /** The single selected shape, or null when zero or several are. */
  readonly selectedShape = computed(() => {
    const ids = this._selectedIds();
    if (ids.length !== 1) return null;
    return this._shapes().find((s) => s.id === ids[0]) ?? null;
  });

  readonly selectedShapes = computed(() => {
    const set = new Set(this._selectedIds());
    return this._shapes().filter((s) => set.has(s.id));
  });

  // ── Select-tool marquee (rubber-band) rectangle, in image space ───────────
  private readonly _marquee = signal<Bounds | null>(null);
  readonly marquee = this._marquee.asReadonly();

  /** One bounding box per shape, for the overlay. */
  readonly boundingBoxes = computed<VectorBoundingBox[]>(() => {
    const boxes: VectorBoundingBox[] = [];
    for (const shape of this._shapes()) {
      const rect = shapeBounds(shape);
      if (rect) boxes.push({ shapeId: shape.id, labelId: shape.labelId, rect });
    }
    return boxes;
  });

  /** The shapes changed in a way to be saved (commit, undo, redo). */
  readonly changed$ = new Subject<void>();
  /** A new action was committed (not undo/redo), to be recorded in the
   *  editor's undo timeline. */
  readonly committed$ = new Subject<void>();

  private readonly history = new VectorHistory();

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

  // Box/Ellipse tool: dragging out a new shape (mirrored into the draft).
  private shapeDrag: {
    origin: Pt;
    id: string;
    labelId: number;
    ellipse: boolean;
  } | null = null;
  // Gizmo knob: rotating the selection around a pivot fixed at drag start.
  // `base` holds the shapes as they were: each move rotates from scratch.
  private rotateDrag: {
    pivot: Pt;
    startAngle: number;
    base: Map<string, VectorShape>;
    moved: boolean;
  } | null = null;
  // Side grip of a box/ellipse: stretching it along `u` away from `anchor`.
  private stretchDrag: {
    base: VectorShape;
    anchor: Pt;
    u: Pt;
    /** Distance from anchor to the grip at drag start. */
    extent: number;
    moved: boolean;
  } | null = null;
  /** Pivot + angle of the rotation in progress, for the gizmo. */
  private readonly _rotation = signal<{ pivot: Pt; angle: number } | null>(null);

  // Not reset by setShapes()/clear(): a shape copied on one frame can be pasted
  // on another.
  private clipboard: VectorShape[] = [];

  constructor() {
    // Leaving Path mode commits the draft. A transient pan does not.
    this.editor.toolChanged$.subscribe((tool) => {
      // A half-dragged box is dropped.
      if (this.shapeDrag) {
        this.shapeDrag = null;
        this._draft.set(null);
        return;
      }
      if (this._draft() && tool !== Tools.PATH && tool !== Tools.PAN) {
        this.finalizeDraft(false, false);
      }
    });

    this.labels.activeLabelChanged$.subscribe(() => this.continueDraftOnLabelChange());
  }

  /**
   * The active label changed while a Pen draft is in progress: commit the
   * current path on the old label and start a new draft from its last point on
   * the new one. A draft too short to be a path is retargeted.
   */
  private continueDraftOnLabelChange(): void {
    const draft = this._draft();
    if (!draft || !this.editor.isPathTool()) return;
    const newId = this.labels.activeLabel?.id;
    if (newId == null || newId === draft.labelId) return;

    if (draft.nodes.length < 2) {
      this._draft.set({ ...draft, labelId: newId });
      return;
    }

    const last = draft.nodes[draft.nodes.length - 1];
    this.finalizeDraft(false, false); // commit the current path (old label)
    this._draft.set({
      id: crypto.randomUUID(),
      labelId: newId,
      closed: false,
      filled: false,
      nodes: [makeNode(last.x, last.y)],
    });
    this._hover.set(null);
    this.penHandleNode = null;
  }

  // ── Frame lifecycle (called by IOService) ─────────────────────────────────

  /** Replace the whole set (on frame load). Resets interaction + history. */
  setShapes(shapes: VectorShape[]): void {
    this._shapes.set(shapes);
    this.resetInteraction();
    this.history.reset(shapes);
  }

  clear(): void {
    this._shapes.set([]);
    this.resetInteraction();
    this.history.reset([]);
  }

  /**
   * @see ProjectScoped
   *
   * Also empties the clipboard: a copied shape carries a `labelId`, which
   * means another label in the next project.
   */
  resetForProject(): void {
    this.clear();
    this.clipboard = [];
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
    this.shapeDrag = null;
    this.rotateDrag = null;
    this.stretchDrag = null;
    this._rotation.set(null);
  }

  /** Drop every shape of `labelId`, as one undoable action. */
  deleteShapesForLabel(labelId: number): void {
    const ids = this._shapes()
      .filter((s) => s.labelId === labelId)
      .map((s) => s.id);
    this.deleteShapesByIds(ids);
  }

  /** Drop every shape on the frame, as one undoable action. Unlike `clear`,
   *  which resets the editor when another frame is loaded. */
  deleteAllShapes(): void {
    this.deleteShapesByIds(this._shapes().map((s) => s.id));
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
    // The gizmo sits on top of everything, so it gets the first say.
    if (this.gizmoDown(p)) return;
    if (this.editor.isPathTool()) this.penDown(p);
    else if (this.editor.isNodeTool()) this.nodeDown(p);
    else if (this.editor.isSelectTool()) this.selectDown(p, mods);
    else if (this.editor.isShapeTool()) this.shapeDown(p);
  }

  onPointerMove(p: Pt, mods: SelectMods = { shift: false, toggle: false }): void {
    if (this.rotateDrag) this.rotateMove(p, mods);
    else if (this.stretchDrag) this.stretchMove(p);
    else if (this.shapeDrag) this.shapeMove(p, mods);
    else if (this.editor.isPathTool()) this.penMove(p);
    else if (this.editor.isNodeTool()) this.nodeMove(p);
    else if (this.groupDrag || this.marqueeDrag) this.selectMove(p);
  }

  onPointerUp(): void {
    if (this.rotateDrag) {
      this.rotateUp();
    } else if (this.stretchDrag) {
      if (this.stretchDrag.moved) this.commit(); // one undoable step
      this.stretchDrag = null;
    } else if (this.shapeDrag) {
      this.shapeUp();
    } else if (this.editor.isNodeTool() && (this.nodeDrag || this.handleDrag)) {
      this.commit(); // commit a node/handle drag once, at the end
    } else if (this.groupDrag || this.marqueeDrag) {
      this.selectUp();
    }
    this.pointerDown = false;
    this.penHandleNode = null;
    this.nodeDrag = null;
    this.handleDrag = null;
  }

  /**
   * Select tool: open the path for node editing. Node tool: on a node, toggle
   * its smoothness; on a path, insert a node.
   */
  onDoubleClick(p: Pt): void {
    if (this.editor.isPathTool()) {
      // Double-click finishes the open path. Its second press placed a duplicate
      // node: drop it.
      const draft = this._draft();
      if (draft && draft.nodes.length >= 2) {
        const n = draft.nodes;
        if (distance(n[n.length - 1], n[n.length - 2]) < this.tol()) {
          this._draft.set({ ...draft, nodes: n.slice(0, -1) });
        }
        this.finishDraft();
      }
      return;
    }
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

  finishDraft(): void {
    if (this._draft()) this.finalizeDraft(false);
  }

  /** Esc: cancel an in-progress draft, otherwise clear the selection. */
  cancel(): void {
    if (this.rotateDrag) {
      this.restoreRotateBase();
      this.rotateDrag = null;
      this._rotation.set(null);
      return;
    }
    if (this.stretchDrag) {
      const base = this.stretchDrag.base;
      this._shapes.update((list) => list.map((s) => (s.id === base.id ? base : s)));
      this.stretchDrag = null;
      return;
    }
    if (this._draft()) {
      this._draft.set(null);
      this._hover.set(null);
      this.penHandleNode = null;
      this.shapeDrag = null;
      return;
    }
    this._selectedIds.set([]);
    this._selectedNode.set(null);
    this._marquee.set(null);
    this.groupDrag = null;
    this.marqueeDrag = null;
  }

  /** Delete the selection: every shape when several are selected; with one,
   *  its targeted node (Node tool) or the shape. */
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

  /** Move the selected shape to another label. */
  moveSelectedToLabel(labelId: number): void {
    if (this.labels.listSegmentationLabels.some((l) => l.id === labelId)) {
      this.mutateSelected((s) => ({ ...s, labelId }));
    }
  }

  deleteShapeById(id: string): void {
    if (this._shapes().some((s) => s.id === id)) this.deleteShape(id);
  }

  /** Remove several shapes as one committed action. */
  deleteShapesByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const remove = new Set(ids);
    if (!this._shapes().some((s) => remove.has(s.id))) return;
    this._shapes.update((list) => list.filter((s) => !remove.has(s.id)));
    this._selectedIds.set([]);
    this._selectedNode.set(null);
    this.commit();
  }

  /** Append shapes as one committed action, and select the first. */
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

    // A click on the first node closes the path.
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
      // Dragging out from a node just placed sets a symmetric smooth handle.
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

    this.selectOnly(shape.id);
    if (handoffToNode) this.editor.selectTool(Tools.NODE);
  }

  // ── Node tool ─────────────────────────────────────────────────────────────

  private nodeDown(p: Pt): void {
    const tol = this.tol();
    const current = this.selectedShape();
    // The nodes of a hidden shape cannot be grabbed.
    const sel = current && this.isLabelVisible(current.labelId) ? current : null;

    // The selected shape's handles first, then its anchors.
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
        const moved = { ...nd };
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
      this.groupDrag = { last: p, moved: false, clickedId: hit.id, wasSelected: already };
      return;
    }

    // Empty canvas: begin a marquee.
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
        // A plain click on a shape of a multi-selection selects it alone.
        this.selectOnly(this.groupDrag.clickedId);
      }
      this.groupDrag = null;
    } else if (this.marqueeDrag) {
      const rect = this._marquee();
      if (rect && this.marqueeDrag.moved) {
        this.applyMarquee(rect, this.marqueeDrag.base, this.marqueeDrag.additive);
      }
      this._marquee.set(null);
      this.marqueeDrag = null;
    }
  }

  /** Topmost visible shape under p: a closed body first, else the nearest
   *  outline. */
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

  /** Translate every selected shape, without committing. */
  private translateSelection(dx: number, dy: number): void {
    const ids = new Set(this._selectedIds());
    if (ids.size === 0) return;
    this._shapes.update((list) =>
      list.map((s) => (ids.has(s.id) ? translateShape(s, dx, dy) : s)),
    );
  }

  /** Select the shapes whose bbox intersects the marquee. */
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

  // ── Box / Ellipse tools (drag out a ready-made closed shape) ──────────────

  private shapeDown(p: Pt): void {
    const labelId = this.labels.activeLabel?.id;
    if (labelId == null) return; // need an active label to own the shape
    this.shapeDrag = {
      origin: p,
      id: crypto.randomUUID(),
      labelId,
      ellipse: this.editor.isEllipseTool(),
    };
  }

  private shapeMove(p: Pt, mods: SelectMods): void {
    const drag = this.shapeDrag;
    if (!drag) return;
    const o = drag.origin;
    let dx = p.x - o.x;
    let dy = p.y - o.y;
    if (mods.shift) {
      const side = Math.max(Math.abs(dx), Math.abs(dy));
      dx = dx < 0 ? -side : side;
      dy = dy < 0 ? -side : side;
    }
    const a = mods.toggle ? { x: o.x - dx, y: o.y - dy } : o;
    const b = { x: o.x + dx, y: o.y + dy };
    this._draft.set({
      id: drag.id,
      labelId: drag.labelId,
      closed: true,
      filled: false,
      nodes: drag.ellipse ? ellipseNodes(a, b) : rectNodes(a, b),
    });
  }

  private shapeUp(): void {
    const drag = this.shapeDrag;
    const draft = this._draft();
    this.shapeDrag = null;
    this._draft.set(null);
    if (!drag) return;

    const bounds = draft ? shapeBounds(draft) : null;
    const min = MIN_SHAPE_PX / Math.max(1e-6, this.zoomPan.scale);
    if (!draft || !bounds || bounds.width < min || bounds.height < min) {
      // A click, not a drag: select what is under it.
      this.selectOnly(this.pickSelectable(drag.origin, this.tol())?.id ?? null);
      return;
    }

    this._shapes.update((list) => [...list, draft]);
    this.commit();
    this.selectOnly(draft.id);
  }

  // ── Move / rotate gizmo (Select, Box and Ellipse tools) ───────────────────

  /** The gizmo of the current selection, or null. A method, not a computed: it
   *  depends on the active tool and on label visibility, which are not signals. */
  gizmo(): VectorGizmo | null {
    if (!this.editor.isSelectTool() && !this.editor.isShapeTool()) return null;
    if (this._draft() || this._marquee()) return null;

    const live = this._rotation();
    const pivot = live?.pivot ?? this.selectionCenter();
    if (!pivot) return null;

    const angle = live?.angle ?? 0;
    const arm = GIZMO_ARM_PX / Math.max(1e-6, this.zoomPan.scale);
    return {
      pivot,
      knob: {
        x: pivot.x + arm * Math.sin(angle),
        y: pivot.y - arm * Math.cos(angle),
      },
      angle,
      rotating: live !== null,
    };
  }

  /** Center of the visible selected shapes' joint bounding box. */
  private selectionCenter(): Pt | null {
    const bounds = shapesBounds(
      this.selectedShapes().filter((s) => this.isLabelVisible(s.labelId)),
    );
    if (!bounds) return null;
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  }

  /** Start a rotate (knob) or move (pivot) drag. False when p misses the
   *  gizmo. */
  private gizmoDown(p: Pt): boolean {
    const gizmo = this.gizmo();
    if (!gizmo) return false;
    const tol = this.tol();

    if (distance(p, gizmo.knob) < tol) {
      const base = new Map(this.selectedShapes().map((s) => [s.id, s]));
      this.rotateDrag = {
        pivot: gizmo.pivot,
        startAngle: Math.atan2(p.y - gizmo.pivot.y, p.x - gizmo.pivot.x),
        base,
        moved: false,
      };
      this._rotation.set({ pivot: gizmo.pivot, angle: 0 });
      return true;
    }

    for (const h of this.sideHandles()) {
      if (distance(p, h.pos) >= tol) continue;
      const shape = this.selectedShape();
      if (!shape) break;
      const extent = distance(h.pos, h.anchor);
      this.stretchDrag = {
        base: shape,
        anchor: h.anchor,
        u: { x: (h.pos.x - h.anchor.x) / extent, y: (h.pos.y - h.anchor.y) / extent },
        extent,
        moved: false,
      };
      return true;
    }

    if (distance(p, gizmo.pivot) < tol) {
      this.groupDrag = { last: p, moved: false, clickedId: '', wasSelected: false };
      return true;
    }
    return false;
  }

  /** Resize grips, one per side, when the selection is a single box or
   *  ellipse. Dragging one moves that side along its normal. */
  sideHandles(): SideHandle[] {
    if (!this.gizmo() || this._rotation()) return [];
    const shape = this.selectedShape();
    if (!shape) return [];
    // Too small on screen for grips.
    const min = 4 * this.tol();
    return sideHandles(shape).filter((h) => distance(h.pos, h.anchor) >= min);
  }

  private stretchMove(p: Pt): void {
    const drag = this.stretchDrag;
    if (!drag) return;
    // Stop short of the opposite side: the shape must not collapse or flip.
    const min = MIN_SHAPE_PX / Math.max(1e-6, this.zoomPan.scale);
    const along =
      (p.x - drag.anchor.x) * drag.u.x + (p.y - drag.anchor.y) * drag.u.y;
    const factor = Math.max(min, along) / drag.extent;

    drag.moved = true;
    this._shapes.update((list) =>
      list.map((s) =>
        s.id === drag.base.id
          ? stretchShape(drag.base, drag.anchor, drag.u, factor)
          : s,
      ),
    );
  }

  private rotateMove(p: Pt, mods: SelectMods): void {
    const drag = this.rotateDrag;
    if (!drag) return;
    let angle =
      Math.atan2(p.y - drag.pivot.y, p.x - drag.pivot.x) - drag.startAngle;
    // Kept in (-180°, 180°].
    angle = Math.atan2(Math.sin(angle), Math.cos(angle));
    if (mods.shift) angle = Math.round(angle / ROTATE_SNAP) * ROTATE_SNAP;

    drag.moved = true;
    this._rotation.set({ pivot: drag.pivot, angle });
    this._shapes.update((list) =>
      list.map((s) => {
        const base = drag.base.get(s.id);
        return base ? rotateShape(base, drag.pivot, angle) : s;
      }),
    );
  }

  private rotateUp(): void {
    const drag = this.rotateDrag;
    const angle = this._rotation()?.angle ?? 0;
    this.rotateDrag = null;
    this._rotation.set(null);
    if (drag?.moved && angle !== 0) this.commit(); // one undoable step
  }

  /** Put the shapes of an abandoned rotation back as they were. */
  private restoreRotateBase(): void {
    const base = this.rotateDrag?.base;
    if (!base) return;
    this._shapes.update((list) => list.map((s) => base.get(s.id) ?? s));
  }

  // ── Copy / paste / duplicate (cross-frame) ────────────────────────────────

  copySelection(): void {
    const sel = this.selectedShapes();
    if (sel.length === 0) return;
    this.clipboard = sel.map(cloneShape);
  }

  /** Paste the clipboard into the current frame, with fresh ids and an offset. */
  pasteClipboard(): void {
    if (this.clipboard.length === 0) return;
    this.addCopies(this.clipboard);
  }

  duplicateSelection(): void {
    const sel = this.selectedShapes();
    if (sel.length === 0) return;
    this.addCopies(sel);
  }

  /** Select every path of the visible labels, or of the active label only.
   *  Toggles: clears the selection when everything in scope is selected. */
  selectAll(currentLabelOnly = false): void {
    const activeId = this.labels.activeLabel?.id ?? null;
    const ids = this._shapes()
      .filter(
        (s) =>
          this.isLabelVisible(s.labelId) &&
          (!currentLabelOnly || s.labelId === activeId),
      )
      .map((s) => s.id);

    const selected = new Set(this._selectedIds());
    const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
    this._selectedIds.set(allSelected ? [] : ids);
    this._selectedNode.set(null);
  }

  private addCopies(sources: VectorShape[]): void {
    const copies = sources.map((s) => this.materializeCopy(s));
    if (copies.length === 0) return;
    this._shapes.update((list) => [...list, ...copies]);
    this._selectedIds.set(copies.map((s) => s.id));
    this._selectedNode.set(null);
    this.commit();
  }

  /** A clone with a fresh id and an offset. A missing label becomes the active
   *  one. */
  private materializeCopy(s: VectorShape): VectorShape {
    const labelId = this.labels.listSegmentationLabels.some((l) => l.id === s.labelId)
      ? s.labelId
      : this.labels.activeLabel?.id ?? s.labelId;
    const moved = translateShape(cloneShape(s), PASTE_OFFSET, PASTE_OFFSET);
    return { ...moved, id: crypto.randomUUID(), labelId };
  }

  // ── Selection helpers ─────────────────────────────────────────────────────

  private isSelected(id: string): boolean {
    return this._selectedIds().includes(id);
  }

  /** Reduce the selection to one shape (or none), and make its label the
   *  active one: the tools that follow act on the active label. */
  private selectOnly(id: string | null): void {
    this._selectedIds.set(id ? [id] : []);
    this._selectedNode.set(null);
    const shape = id ? this._shapes().find((s) => s.id === id) : null;
    if (shape) this.labels.activateById(shape.labelId);
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

    // Fewer than 2 nodes is not a path.
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

  /** Transform the single selected shape and commit. */
  private mutateSelected(fn: (s: VectorShape) => VectorShape): void {
    const id = this.primaryId();
    if (!id) return;
    this._shapes.update((list) =>
      list.map((s) => (s.id === id ? fn(s) : s)),
    );
    this.commit();
  }

  /** Like `mutateSelected`, for live drag updates: no commit. */
  private mutateSelectedLive(fn: (s: VectorShape) => VectorShape): void {
    const id = this.primaryId();
    if (!id) return;
    this._shapes.update((list) =>
      list.map((s) => (s.id === id ? fn(s) : s)),
    );
  }

  /** Flip a node between smooth and corner. A corner gains handles tangent to
   *  its neighbours; a smooth node loses them. */
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

  /** Neighbouring anchor, wrapping for closed paths. */
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
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  undo(): boolean {
    const state = this.history.stepBack();
    if (!state) return false;
    this.restore(state);
    return true;
  }

  redo(): boolean {
    const state = this.history.stepForward();
    if (!state) return false;
    this.restore(state);
    return true;
  }

  private commit(): void {
    this.history.commit(this._shapes());
    this.committed$.next(); // record a 'vector' entry in the unified order
    this.changed$.next(); // mark dirty
  }

  private restore(state: VectorShape[]): void {
    this._shapes.set(cloneShapes(state));
    // Drop the selected ids the restored state no longer contains.
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
