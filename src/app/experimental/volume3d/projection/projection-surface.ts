/**
 * The surface the projection is painted on, as a flat image. Pure; see
 * `ProjectionPainterService`.
 *
 * The surface joins, in every slice, the points at depth `t` of the A→B
 * segments. Flattened, it is `columns × rows` pixels: one column per segment
 * and `zSpacing` rows per slice, so that a pixel is as tall as it is wide and a
 * round brush stays round. The editor's tools work on that flat image; what
 * they change is written back to the volume along each segment.
 */
export interface Surface {
  columns: number;
  rows: number;
  /** Size of the volume the surface cuts through. */
  width: number;
  height: number;
  depth: number;
  /** Per column, the point at the painting depth and the unit direction of
   *  its segment: `[x, y, ux, uy]`. */
  points: Float32Array;
  /** Per column, the offset of that point's voxel within a slice, or -1 when
   *  it falls outside the image. */
  locals: Int32Array;
}

/** Tallest surface: the editor's stroke buffer is capped at this size. */
export const MAX_SURFACE_ROWS = 4096;

export function buildSurface(
  ends: Float32Array,
  columns: number,
  width: number,
  height: number,
  depth: number,
  zSpacing: number,
  t: number,
): Surface {
  const points = new Float32Array(columns * 4);
  const locals = new Int32Array(columns);
  for (let c = 0; c < columns; c++) {
    const ax = ends[c * 4], ay = ends[c * 4 + 1], bx = ends[c * 4 + 2], by = ends[c * 4 + 3];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    const x = ax + dx * t, y = ay + dy * t;
    points[c * 4] = x;
    points[c * 4 + 1] = y;
    points[c * 4 + 2] = len < 1e-6 ? 0 : dx / len;
    points[c * 4 + 3] = len < 1e-6 ? 0 : dy / len;
    locals[c] = voxelOffset(x, y, width, height);
  }
  const rows = Math.min(MAX_SURFACE_ROWS, Math.max(1, Math.round(depth * zSpacing)));
  return { columns, rows, width, height, depth, points, locals };
}

/** The slice a surface row shows. */
export function rowToSlice(row: number, surface: Surface): number {
  return Math.min(surface.depth - 1, Math.floor((row * surface.depth) / surface.rows));
}

/** The row that stands for slice `z` when the surface is written back: the
 *  middle one of the rows showing it. */
export function sliceToRow(z: number, surface: Surface): number {
  return Math.min(surface.rows - 1, Math.floor(((z + 0.5) * surface.rows) / surface.depth));
}

/** Read one label volume on the surface into `out` (`columns * rows`). */
export function sampleSurface(volume: Uint8Array, surface: Surface, out: Uint8Array): void {
  const { columns, rows, locals } = surface;
  const sliceSize = surface.width * surface.height;
  for (let row = 0; row < rows; row++) {
    const base = rowToSlice(row, surface) * sliceSize;
    const o = row * columns;
    for (let c = 0; c < columns; c++) {
      const local = locals[c];
      out[o + c] = local < 0 ? 0 : volume[base + local];
    }
  }
}

/**
 * The voxels of one slice that a surface pixel of column `c` stands for: those
 * within `radius` pixels of the surface, along the segment. Offsets are within
 * the slice and may repeat.
 */
export function forEachColumnVoxel(
  surface: Surface,
  c: number,
  radius: number,
  visit: (local: number) => void,
): void {
  const { points, width, height } = surface;
  const x = points[c * 4], y = points[c * 4 + 1], ux = points[c * 4 + 2], uy = points[c * 4 + 3];
  if (ux === 0 && uy === 0) {
    const local = voxelOffset(x, y, width, height);
    if (local >= 0) visit(local);
    return;
  }
  // Half-pixel steps, so no voxel the segment crosses is skipped.
  const k = Math.floor(radius * 2);
  for (let i = -k; i <= k; i++) {
    const local = voxelOffset(x + ux * i * 0.5, y + uy * i * 0.5, width, height);
    if (local >= 0) visit(local);
  }
}

function voxelOffset(x: number, y: number, width: number, height: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  return xi < 0 || yi < 0 || xi >= width || yi >= height ? -1 : yi * width + xi;
}
