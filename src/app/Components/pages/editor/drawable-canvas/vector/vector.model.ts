import { VectorNode, VectorShape } from '../../../../../lib/api';

// Re-export the wire types so the editor code can treat the model file as the
// single import site for vector types.
export type { VectorNode, VectorShape } from '../../../../../lib/api';

export interface Pt {
  x: number;
  y: number;
}

/** Create a fresh anchor node whose handles coincide with it (straight). */
export function makeNode(x: number, y: number, smooth = false): VectorNode {
  return { x, y, inX: x, inY: y, outX: x, outY: y, smooth };
}

/** True when a handle sits exactly on its anchor (a straight-segment endpoint). */
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

/**
 * Sample a shape into a polyline (image space). Straight segments contribute a
 * single endpoint; curved ones are subdivided. Used for hit-testing and, later,
 * export rasterization.
 */
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

/**
 * Axis-aligned bounding box of a shape in image space, or null when it has no
 * geometry. Uses the flattened polyline so curved segments are covered.
 */
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

/** True when two axis-aligned boxes overlap (touching edges count). */
export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

/**
 * Even-odd point-in-polygon test against the shape's flattened outline. Used to
 * hit-test the *body* of a closed path (so clicking its interior selects it),
 * whereas open paths are picked by outline proximity (`distanceToShape`).
 */
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

/** Translate a whole shape (anchors + both handles) by (dx, dy) in image space. */
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

/** Squared distance from p to segment ab. */
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

/** Shortest distance (image px) from a point to a shape's outline. */
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

/** Closest segment index + parameter on a shape to point p (sampled). */
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

/**
 * Insert a node on segment `segIndex` at parameter `t`, preserving the curve
 * via de Casteljau subdivision (or a plain midpoint on straight segments).
 * Returns a new shape; the inserted node is at index `segIndex + 1`.
 */
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

/** True when a node's handle sits on its anchor (i.e. a straight segment end). */
function handleIsFlat(nx: number, ny: number, hx: number, hy: number): boolean {
  return nx === hx && ny === hy;
}

/**
 * Build an SVG path `d` string from a shape, in image-space coordinates.
 *
 * Every segment is emitted as a cubic so the same code handles beziers,
 * polygons and polylines; a straight segment simply has its control points on
 * the anchors, which renders identically to a line.
 */
export function buildPathData(shape: VectorShape): string {
  const n = shape.nodes;
  if (n.length === 0) return '';
  if (n.length === 1) {
    // A lone node has no segment; emit a degenerate move so it can still be hit.
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
