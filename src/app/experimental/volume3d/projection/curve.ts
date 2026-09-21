/**
 * Curve geometry for the projection view. Pure functions.
 *
 * A curve is the smooth spline through its control points: a centripetal
 * Catmull-Rom spline, evaluated as one cubic Bézier per span. Centripetal
 * parameterisation never loops or overshoots between close points, which a
 * user clicking points expects.
 */

export interface Point {
  x: number;
  y: number;
}

/** Cubic Bézier spans `[p0, c1, c2, p1]` of the spline through `points`. */
export function splineBeziers(points: readonly Point[]): [Point, Point, Point, Point][] {
  const spans: [Point, Point, Point, Point][] = [];
  const n = points.length;
  for (let i = 0; i + 1 < n; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(n - 1, i + 2)];
    // Centripetal knot intervals (alpha = 0.5); guard coincident points.
    const d01 = Math.max(Math.sqrt(dist(p0, p1)), 1e-4);
    const d12 = Math.max(Math.sqrt(dist(p1, p2)), 1e-4);
    const d23 = Math.max(Math.sqrt(dist(p2, p3)), 1e-4);
    // Tangents at p1 and p2 of the Catmull-Rom segment (Barry–Goldman),
    // scaled to the [0, 1] span. At the ends there is no outer neighbour:
    // head straight for the next point instead.
    const chord = { x: p2.x - p1.x, y: p2.y - p1.y };
    const m1 = i === 0 ? chord : tangent(p0, p1, p2, d01, d12, d12);
    const m2 = i + 2 >= n ? chord : tangent(p1, p2, p3, d12, d23, d12);
    spans.push([
      p1,
      { x: p1.x + m1.x / 3, y: p1.y + m1.y / 3 },
      { x: p2.x - m2.x / 3, y: p2.y - m2.y / 3 },
      p2,
    ]);
  }
  return spans;
}

/** SVG path data for the spline through `points`. */
export function splinePath(points: readonly Point[]): string {
  if (points.length === 0) return '';
  const spans = splineBeziers(points);
  let d = `M ${points[0].x} ${points[0].y}`;
  for (const [, c1, c2, p] of spans) d += ` C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p.x} ${p.y}`;
  return d;
}

/**
 * `count` points evenly spaced by arc length along the spline through
 * `points`, first and last included. Empty when there are fewer than two
 * points.
 */
export function resampleByArcLength(points: readonly Point[], count: number): Point[] {
  const poly = flatten(points);
  if (poly.length < 2 || count < 2) return [];
  const cumulative = [0];
  for (let i = 1; i < poly.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
  }
  const total = cumulative[cumulative.length - 1];
  const out: Point[] = [];
  let seg = 1;
  for (let k = 0; k < count; k++) {
    const target = (total * k) / (count - 1);
    while (seg < poly.length - 1 && cumulative[seg] < target) seg++;
    const span = cumulative[seg] - cumulative[seg - 1];
    const t = span > 0 ? (target - cumulative[seg - 1]) / span : 0;
    out.push({
      x: poly[seg - 1].x + (poly[seg].x - poly[seg - 1].x) * t,
      y: poly[seg - 1].y + (poly[seg].y - poly[seg - 1].y) * t,
    });
  }
  return out;
}

/** Length of the spline through `points`. */
export function splineLength(points: readonly Point[]): number {
  const poly = flatten(points);
  let length = 0;
  for (let i = 1; i < poly.length; i++) {
    length += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
  }
  return length;
}

/** The spline as a dense polyline (about one vertex per pixel). */
function flatten(points: readonly Point[]): Point[] {
  if (points.length < 2) return [...points];
  const out: Point[] = [points[0]];
  for (const [p0, c1, c2, p1] of splineBeziers(points)) {
    // The control polygon bounds the span's length.
    const bound = Math.hypot(c1.x - p0.x, c1.y - p0.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(p1.x - c2.x, p1.y - c2.y);
    const steps = Math.max(2, Math.min(512, Math.ceil(bound)));
    for (let i = 1; i <= steps; i++) out.push(bezier(p0, c1, c2, p1, i / steps));
  }
  return out;
}

function bezier(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * p0.x + b * c1.x + c * c2.x + d * p1.x, y: a * p0.y + b * c1.y + c * c2.y + d * p1.y };
}

/** Derivative at `b` of the centripetal Catmull-Rom through `a, b, c`
 *  (knot intervals `dab`, `dbc`), rescaled to a Bézier span whose knot
 *  interval is `span`. */
function tangent(a: Point, b: Point, c: Point, dab: number, dbc: number, span: number): Point {
  const t = (p: 'x' | 'y') =>
    ((b[p] - a[p]) / dab - (c[p] - a[p]) / (dab + dbc) + (c[p] - b[p]) / dbc) * span;
  return { x: t('x'), y: t('y') };
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Index `i` of the span (control points `i` → `i+1`) of the spline through
 * `points` that passes closest to `p`, with that distance; null for fewer
 * than two points. Inserting at `i + 1` puts a point on that span.
 */
export function closestSpan(points: readonly Point[], p: Point): { index: number; distance: number } | null {
  let best: { index: number; distance: number } | null = null;
  splineBeziers(points).forEach(([p0, c1, c2, p1], index) => {
    for (let s = 0; s <= 32; s++) {
      const q = bezier(p0, c1, c2, p1, s / 32);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.distance) best = { index, distance: d };
    }
  });
  return best;
}

/**
 * A few control points whose spline follows the polyline `poly`: the
 * polyline simplified (Douglas–Peucker) with a tolerance that grows until at
 * most `maxPoints` remain. Keeps curves taken from annotations editable.
 */
export function controlPointsFor(poly: readonly Point[], maxPoints = 24): Point[] {
  if (poly.length <= 2) return [...poly];
  let tolerance = 1;
  let out = simplify(poly, tolerance);
  while (out.length > maxPoints && tolerance < 1e4) {
    tolerance *= 1.5;
    out = simplify(poly, tolerance);
  }
  return out;
}

function simplify(poly: readonly Point[], tolerance: number): Point[] {
  const keep = new Uint8Array(poly.length);
  keep[0] = keep[poly.length - 1] = 1;
  const stack: [number, number][] = [[0, poly.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let worst = -1;
    let worstDistance = tolerance;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(poly[i], poly[first], poly[last]);
      if (d > worstDistance) {
        worst = i;
        worstDistance = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([first, worst], [worst, last]);
    }
  }
  return poly.filter((_, i) => keep[i]);
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The longest route through a skeleton given as branches (polylines that meet
 * at their endpoints), as one polyline. Side spurs are dropped: this is the
 * main centerline of an elongated structure. Branch ends closer than `snap`
 * pixels count as the same junction.
 */
export function longestSkeletonPath(branches: readonly Point[][], snap = 2): Point[] {
  const usable = branches.filter((b) => b.length >= 2);
  if (usable.length === 0) return [];

  // Junctions: branch endpoints merged within `snap`.
  const nodes: Point[] = [];
  const nodeOf = (p: Point) => {
    let i = nodes.findIndex((n) => Math.hypot(n.x - p.x, n.y - p.y) <= snap);
    if (i < 0) i = nodes.push(p) - 1;
    return i;
  };
  const edges = usable.map((poly) => ({
    poly,
    from: nodeOf(poly[0]),
    to: nodeOf(poly[poly.length - 1]),
    length: polylineLength(poly),
  }));

  // Farthest node from `start` along the branches, with the edges leading there.
  const farthest = (start: number) => {
    const dist = new Array(nodes.length).fill(Infinity);
    const via: number[] = new Array(nodes.length).fill(-1);
    dist[start] = 0;
    const done = new Uint8Array(nodes.length);
    for (;;) {
      let u = -1;
      for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0) break;
      done[u] = 1;
      edges.forEach((e, k) => {
        const v = e.from === u ? e.to : e.to === u ? e.from : -1;
        if (v >= 0 && dist[u] + e.length < dist[v]) {
          dist[v] = dist[u] + e.length;
          via[v] = k;
        }
      });
    }
    let end = start;
    for (let i = 0; i < nodes.length; i++) if (dist[i] < Infinity && dist[i] > dist[end]) end = i;
    return { end, via };
  };

  // Double sweep: the farthest node from anywhere, then the farthest from it.
  const { end: u } = farthest(edges[0].from);
  const { end: v, via } = farthest(u);
  if (u === v) {
    // A single closed loop (or one branch): take the longest branch as is.
    return [...edges.reduce((a, b) => (b.length > a.length ? b : a)).poly];
  }

  // Walk back from v to u, then emit the branches from u to v.
  const path: Point[] = [];
  let node = v;
  const steps: { poly: Point[]; reversed: boolean }[] = [];
  while (node !== u) {
    const e = edges[via[node]];
    const prev = e.from === node ? e.to : e.from;
    steps.push({ poly: e.poly, reversed: e.from === node });
    node = prev;
  }
  for (const { poly, reversed } of steps.reverse()) {
    const oriented = reversed ? [...poly].reverse() : poly;
    path.push(...(path.length > 0 ? oriented.slice(1) : oriented));
  }
  return path;
}

function polylineLength(poly: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < poly.length; i++) length += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
  return length;
}
