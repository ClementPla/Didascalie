import { VectorNode, VectorShape } from '../../../../lib/api';

export type { VectorNode, VectorShape } from '../../../../lib/api';

export interface Pt {
  x: number;
  y: number;
}

/** A node whose handles coincide with it. */
export function makeNode(x: number, y: number, smooth = false): VectorNode {
  return { x, y, inX: x, inY: y, outX: x, outY: y, smooth };
}

/** The handle sits on its anchor (the end of a straight segment). */
export function isFlatHandle(
  ax: number,
  ay: number,
  hx: number,
  hy: number,
): boolean {
  return ax === hx && ay === hy;
}

function cubicPoint(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Sample a shape into a polyline (image space). Curved segments are
 *  subdivided. */
export function flattenShape(shape: VectorShape, samples = 16): Pt[] {
  const n = shape.nodes;
  if (n.length === 0) return [];
  if (n.length === 1) return [{ x: n[0].x, y: n[0].y }];

  const pts: Pt[] = [{ x: n[0].x, y: n[0].y }];
  const segments = shape.closed ? n.length : n.length - 1;

  for (let i = 0; i < segments; i++) {
    const a = n[i];
    const b = n[(i + 1) % n.length];
    const straight =
      isFlatHandle(a.x, a.y, a.outX, a.outY) &&
      isFlatHandle(b.x, b.y, b.inX, b.inY);

    if (straight) {
      pts.push({ x: b.x, y: b.y });
    } else {
      const p0 = { x: a.x, y: a.y };
      const p1 = { x: a.outX, y: a.outY };
      const p2 = { x: b.inX, y: b.inY };
      const p3 = { x: b.x, y: b.y };
      for (let s = 1; s <= samples; s++) {
        pts.push(cubicPoint(p0, p1, p2, p3, s / samples));
      }
    }
  }
  return pts;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Bounding box of a shape, from its flattened polyline, or null. */
export function shapeBounds(shape: VectorShape): Bounds | null {
  const pts = flattenShape(shape);
  if (pts.length === 0) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

/** Even-odd point-in-polygon test against the shape's flattened outline. */
export function pointInShape(shape: VectorShape, p: Pt): boolean {
  if (!shape.closed) return false;
  const poly = flattenShape(shape);
  if (poly.length < 3) return false;

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i].y;
    const yj = poly[j].y;
    const xi = poly[i].x;
    const xj = poly[j].x;
    const intersects =
      yi > p.y !== yj > p.y &&
      p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function cloneShape(shape: VectorShape): VectorShape {
  return { ...shape, nodes: shape.nodes.map((n) => ({ ...n })) };
}

export function cloneShapes(shapes: VectorShape[]): VectorShape[] {
  return shapes.map(cloneShape);
}

export function translateShape(
  shape: VectorShape,
  dx: number,
  dy: number,
): VectorShape {
  return {
    ...shape,
    nodes: shape.nodes.map((n) => ({
      ...n,
      x: n.x + dx,
      y: n.y + dy,
      inX: n.inX + dx,
      inY: n.inY + dy,
      outX: n.outX + dx,
      outY: n.outY + dy,
    })),
  };
}

/** Rotate a shape by `angle` radians around `pivot`. */
export function rotateShape(
  shape: VectorShape,
  pivot: Pt,
  angle: number,
): VectorShape {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rx = (x: number, y: number) =>
    pivot.x + (x - pivot.x) * cos - (y - pivot.y) * sin;
  const ry = (x: number, y: number) =>
    pivot.y + (x - pivot.x) * sin + (y - pivot.y) * cos;
  return {
    ...shape,
    nodes: shape.nodes.map((n) => ({
      ...n,
      x: rx(n.x, n.y),
      y: ry(n.x, n.y),
      inX: rx(n.inX, n.inY),
      inY: ry(n.inX, n.inY),
      outX: rx(n.outX, n.outY),
      outY: ry(n.outX, n.outY),
    })),
  };
}

/**
 * Stretch a shape along the unit direction `u`, keeping fixed the line
 * through `anchor` perpendicular to `u`. Affine, so a rotated box stays a
 * rotated box and an ellipse an ellipse.
 */
export function stretchShape(
  shape: VectorShape,
  anchor: Pt,
  u: Pt,
  factor: number,
): VectorShape {
  const k = factor - 1;
  const sx = (x: number, y: number) =>
    x + k * ((x - anchor.x) * u.x + (y - anchor.y) * u.y) * u.x;
  const sy = (x: number, y: number) =>
    y + k * ((x - anchor.x) * u.x + (y - anchor.y) * u.y) * u.y;
  return {
    ...shape,
    nodes: shape.nodes.map((n) => ({
      ...n,
      x: sx(n.x, n.y),
      y: sy(n.x, n.y),
      inX: sx(n.inX, n.inY),
      inY: sy(n.inX, n.inY),
      outX: sx(n.outX, n.outY),
      outY: sy(n.outX, n.outY),
    })),
  };
}

/** A resize grip on one side of a box or ellipse, and the opposite point,
 *  which stays put. */
export interface SideHandle {
  pos: Pt;
  anchor: Pt;
}

/** The four side grips of a box or an ellipse, read off its geometry.
 *  Empty for any other path. */
export function sideHandles(shape: VectorShape): SideHandle[] {
  const n = shape.nodes;
  if (!shape.closed || n.length !== 4) return [];

  const flat = (i: number) =>
    isFlatHandle(n[i].x, n[i].y, n[i].inX, n[i].inY) &&
    isFlatHandle(n[i].x, n[i].y, n[i].outX, n[i].outY);
  const curved = (i: number) =>
    !isFlatHandle(n[i].x, n[i].y, n[i].inX, n[i].inY) &&
    !isFlatHandle(n[i].x, n[i].y, n[i].outX, n[i].outY);
  const all = [0, 1, 2, 3];

  let pts: Pt[];
  if (all.every(flat)) {
    pts = all.map((i) => lerpPt(n[i], n[(i + 1) % 4], 0.5));
  } else if (all.every(curved)) {
    pts = all.map((i) => ({ x: n[i].x, y: n[i].y }));
  } else {
    return [];
  }
  return pts.map((pos, i) => ({ pos, anchor: pts[(i + 2) % 4] }));
}

/** Union of the shapes' bounding boxes, or null when none has geometry. */
export function shapesBounds(shapes: VectorShape[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const b = shapeBounds(shape);
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function rectNodes(a: Pt, b: Pt): VectorNode[] {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  return [
    makeNode(x0, y0),
    makeNode(x1, y0),
    makeNode(x1, y1),
    makeNode(x0, y1),
  ];
}

/** Handle length, as a fraction of the radius, that makes four cubic segments
 *  approximate a circle. */
const CIRCLE_KAPPA = 0.5522847498;

/** Four smooth nodes tracing the ellipse inscribed in the rectangle spanning
 *  a and b. */
export function ellipseNodes(a: Pt, b: Pt): VectorNode[] {
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2;
  const ry = Math.abs(b.y - a.y) / 2;
  const kx = rx * CIRCLE_KAPPA;
  const ky = ry * CIRCLE_KAPPA;
  const node = (
    x: number,
    y: number,
    tx: number,
    ty: number,
  ): VectorNode => ({
    x,
    y,
    inX: x - tx,
    inY: y - ty,
    outX: x + tx,
    outY: y + ty,
    smooth: true,
  });
  return [
    node(cx, cy - ry, kx, 0),
    node(cx + rx, cy, 0, ky),
    node(cx, cy + ry, -kx, 0),
    node(cx - rx, cy, 0, -ky),
  ];
}

function distSqToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  const ex = p.x - cx;
  const ey = p.y - cy;
  return ex * ex + ey * ey;
}

/** Distance (image px) from a point to a shape's outline. */
export function distanceToShape(shape: VectorShape, p: Pt): number {
  const poly = flattenShape(shape);
  if (poly.length === 0) return Infinity;
  if (poly.length === 1) return Math.hypot(p.x - poly[0].x, p.y - poly[0].y);

  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) {
    best = Math.min(best, distSqToSegment(p, poly[i], poly[i + 1]));
  }
  return Math.sqrt(best);
}

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Point at parameter t (0..1) along the segment between two nodes. */
export function segmentPoint(a: VectorNode, b: VectorNode, t: number): Pt {
  return cubicPoint(
    { x: a.x, y: a.y },
    { x: a.outX, y: a.outY },
    { x: b.inX, y: b.inY },
    { x: b.x, y: b.y },
    t,
  );
}

/** The segment of a shape closest to p, and the parameter along it. */
export function closestSegment(
  shape: VectorShape,
  p: Pt,
  samples = 24,
): { segIndex: number; t: number; dist: number } | null {
  const n = shape.nodes;
  if (n.length < 2) return null;
  const segs = shape.closed ? n.length : n.length - 1;

  let best = { segIndex: 0, t: 0, dist: Infinity };
  for (let i = 0; i < segs; i++) {
    const a = n[i];
    const b = n[(i + 1) % n.length];
    for (let s = 1; s <= samples; s++) {
      const t = s / samples;
      const pt = segmentPoint(a, b, t);
      const d = Math.hypot(pt.x - p.x, pt.y - p.y);
      if (d < best.dist) best = { segIndex: i, t, dist: d };
    }
  }
  return best;
}

/** Insert a node on segment `segIndex` at parameter `t` (de Casteljau).
 *  Returns a new shape, with the node at index `segIndex + 1`. */
export function splitSegment(
  shape: VectorShape,
  segIndex: number,
  t: number,
): VectorShape {
  const n = shape.nodes;
  const i = segIndex;
  const a = n[i];
  const b = n[(i + 1) % n.length];
  const straight =
    isFlatHandle(a.x, a.y, a.outX, a.outY) &&
    isFlatHandle(b.x, b.y, b.inX, b.inY);

  const nodes = [...n];
  let inserted: VectorNode;

  if (straight) {
    const s = lerpPt({ x: a.x, y: a.y }, { x: b.x, y: b.y }, t);
    inserted = makeNode(s.x, s.y, false);
  } else {
    const P0 = { x: a.x, y: a.y };
    const P1 = { x: a.outX, y: a.outY };
    const P2 = { x: b.inX, y: b.inY };
    const P3 = { x: b.x, y: b.y };
    const Q0 = lerpPt(P0, P1, t);
    const Q1 = lerpPt(P1, P2, t);
    const Q2 = lerpPt(P2, P3, t);
    const R0 = lerpPt(Q0, Q1, t);
    const R1 = lerpPt(Q1, Q2, t);
    const S = lerpPt(R0, R1, t);

    nodes[i] = { ...a, outX: Q0.x, outY: Q0.y };
    nodes[(i + 1) % n.length] = { ...b, inX: Q2.x, inY: Q2.y };
    inserted = {
      x: S.x,
      y: S.y,
      inX: R0.x,
      inY: R0.y,
      outX: R1.x,
      outY: R1.y,
      smooth: true,
    };
  }

  nodes.splice(i + 1, 0, inserted);
  return { ...shape, nodes };
}

function handleIsFlat(nx: number, ny: number, hx: number, hy: number): boolean {
  return nx === hx && ny === hy;
}

/** SVG path data of a shape, in image coordinates. Every segment is a cubic;
 *  a straight one has its control points on the anchors. */
export function buildPathData(shape: VectorShape): string {
  const n = shape.nodes;
  if (n.length === 0) return '';
  if (n.length === 1) {
    // A lone node: a degenerate move, so it can still be hit.
    return `M ${n[0].x} ${n[0].y}`;
  }

  let d = `M ${n[0].x} ${n[0].y}`;
  const segments = shape.closed ? n.length : n.length - 1;

  for (let i = 0; i < segments; i++) {
    const a = n[i];
    const b = n[(i + 1) % n.length];

    const straight =
      handleIsFlat(a.x, a.y, a.outX, a.outY) &&
      handleIsFlat(b.x, b.y, b.inX, b.inY);

    d += straight
      ? ` L ${b.x} ${b.y}`
      : ` C ${a.outX} ${a.outY} ${b.inX} ${b.inY} ${b.x} ${b.y}`;
  }

  if (shape.closed) d += ' Z';
  return d;
}
