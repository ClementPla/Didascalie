import { Point2D } from '../interface';

/**
 * Pulled-string stabilizer: the brush trails the pointer on a string of length
 * `radius` and moves only once the string is taut, so pointer jitter smaller
 * than `radius` never reaches the brush.
 */
export function pullString(brush: Point2D, pointer: Point2D, radius: number): Point2D {
  const dx = pointer.x - brush.x;
  const dy = pointer.y - brush.y;
  const d = Math.hypot(dx, dy);
  if (d <= radius) return brush;
  const t = (d - radius) / d;
  return { x: brush.x + dx * t, y: brush.y + dy * t };
}

/**
 * The polyline resampled every `spacing` along its length. Pointer events come
 * at a fixed rate, so raw points crowd where the hand slows down; even spacing
 * makes a filter window cover the same length everywhere.
 */
export function resample(points: Point2D[], spacing: number, closed = false): Point2D[] {
  const n = points.length;
  if (n < 2 || spacing <= 0) return points.slice();

  const out: Point2D[] = [points[0]];
  let carry = 0; // length travelled since the last sample
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    let pos = spacing - carry;
    while (pos <= len) {
      const t = pos / len;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      pos += spacing;
    }
    carry = len - (pos - spacing);
  }

  const last = out[out.length - 1];
  if (closed) {
    // The loop's last sample can land on the first one.
    if (out.length > 1 && Math.hypot(last.x - out[0].x, last.y - out[0].y) < spacing / 2) {
      out.pop();
    }
  } else {
    const end = points[n - 1];
    if (last.x !== end.x || last.y !== end.y) out.push(end);
  }
  return out;
}

/** Mean over `±half` samples. A closed path wraps around; an open one narrows
 *  the window towards its ends, which stay where they are. */
function boxFilter(pts: Point2D[], half: number, closed: boolean): Point2D[] {
  const n = pts.length;
  if (half < 1 || n < 3) return pts;

  if (closed) {
    half = Math.min(half, Math.floor((n - 1) / 2));
    // Prefix sums over the path padded with `half` wrapped samples each side.
    const m = n + 2 * half;
    const sx = new Float64Array(m + 1);
    const sy = new Float64Array(m + 1);
    for (let k = 0; k < m; k++) {
      const p = pts[(((k - half) % n) + n) % n];
      sx[k + 1] = sx[k] + p.x;
      sy[k + 1] = sy[k] + p.y;
    }
    const w = 2 * half + 1;
    const out: Point2D[] = new Array(n);
    for (let i = 0; i < n; i++) {
      // Sample i sits at padded index i + half; its window is [i, i + 2·half].
      out[i] = { x: (sx[i + w] - sx[i]) / w, y: (sy[i + w] - sy[i]) / w };
    }
    return out;
  }

  const sx = new Float64Array(n + 1);
  const sy = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) {
    sx[k + 1] = sx[k] + pts[k].x;
    sy[k + 1] = sy[k] + pts[k].y;
  }
  const out: Point2D[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = Math.min(half, i, n - 1 - i);
    const w = 2 * h + 1;
    out[i] = { x: (sx[i + h + 1] - sx[i - h]) / w, y: (sy[i + h + 1] - sy[i - h]) / w };
  }
  return out;
}

/**
 * The path with jitter shorter than about `radius` smoothed out: resampled
 * every `spacing`, then box-filtered twice (a triangular kernel). Points stay
 * inside the convex hull of the input, so the stroke's bounding box still
 * holds them.
 */
export function smoothPath(
  points: Point2D[],
  radius: number,
  spacing: number,
  closed: boolean
): Point2D[] {
  if (radius <= 0 || points.length < 3 || spacing <= 0) return points;
  const even = resample(points, spacing, closed);
  const half = Math.round(radius / spacing);
  return boxFilter(boxFilter(even, half, closed), half, closed);
}
