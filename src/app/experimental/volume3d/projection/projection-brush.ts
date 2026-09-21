/**
 * Geometry of a projection brush dab. Pure; see `ProjectionPainterService`.
 *
 * A dab at projection position (`col`, `zf`) is a ball of radius `r` image
 * pixels centred on the point at depth `t` of that column's segment in slice
 * `zf`. The ball spans columns (≈ one pixel of arc length each), slices
 * (`zSpacing` pixels apart) and the segment direction. Each covered point is
 * reported once per half pixel; callers deduplicate voxels.
 */
export function forEachDabPoint(
  ends: Float32Array,
  count: number,
  depth: number,
  col: number,
  zf: number,
  r: number,
  zSpacing: number,
  t: number,
  visit: (x: number, y: number, z: number) => void,
): void {
  const z0 = Math.max(0, Math.ceil(zf - r / zSpacing));
  const z1 = Math.min(depth - 1, Math.floor(zf + r / zSpacing));
  for (let z = z0; z <= z1; z++) {
    const dz = (z - zf) * zSpacing;
    const rz2 = r * r - dz * dz;
    if (rz2 < 0) continue;
    const rz = Math.sqrt(rz2);
    const c0 = Math.max(0, Math.ceil(col - rz));
    const c1 = Math.min(count - 1, Math.floor(col + rz));
    for (let c = c0; c <= c1; c++) {
      const dc = c - col;
      const rc2 = rz2 - dc * dc;
      if (rc2 < 0) continue;
      const rc = Math.sqrt(rc2);
      const ax = ends[c * 4], ay = ends[c * 4 + 1], bx = ends[c * 4 + 2], by = ends[c * 4 + 3];
      const dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy);
      const px = ax + dx * t, py = ay + dy * t;
      if (len < 1e-6) {
        visit(px, py, z);
        continue;
      }
      const ux = dx / len, uy = dy / len;
      // Half-pixel steps along the segment, within the ball.
      const k = Math.ceil(rc * 2);
      for (let i = -k; i <= k; i++) {
        const s = i * 0.5;
        if (Math.abs(s) <= rc) visit(px + ux * s, py + uy * s, z);
      }
    }
  }
}
