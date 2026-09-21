/**
 * Brick-wise surface extraction from a binary occupancy grid.
 *
 * Pure functions, no DOM: they run in the mesher worker (and in tests).
 *
 * # Coordinates
 *
 * Voxel `(x, y, z)` of an `nx×ny×nz` grid is centred on the integer point
 * `(x, y, z)`; everything outside the grid reads as empty, so surfaces close at
 * the volume's border. Output positions are in these grid units — the renderer
 * scales them to voxels / physical spacing.
 *
 * # Bricks
 *
 * The grid is split into `B³` bricks meshed independently, so an edit only
 * remeshes the bricks around it. Each brick owns a disjoint set of output
 * primitives (edges for the smooth surface, voxels for blocks) and reads
 * whatever neighbours it needs, so the union of all bricks equals a mesh of the
 * whole grid: no seams, no duplicated faces. Vertices on a brick border are
 * computed identically by both bricks (same inputs, same arithmetic), which
 * keeps shading continuous across the border.
 *
 * # Smooth surface
 *
 * Surface nets: one vertex per cell (2×2×2 voxels) whose corners disagree, one
 * quad per grid edge whose ends disagree. Vertex positions come from a 3×3×3
 * box-blurred copy of the occupancy (iso-level 0.5), which rounds off the
 * voxel staircase; normals are the blurred field's gradient.
 *
 * # Blocks
 *
 * The exact voxels: every face between a filled and an empty voxel, merged into
 * rectangles per plane (greedy meshing).
 */

export interface Grid {
  nx: number;
  ny: number;
  nz: number;
  /** `nx*ny*nz` occupancy, x fastest; nonzero = filled. */
  data: Uint8Array;
}

export interface BrickMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

export const EMPTY_MESH: BrickMesh = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
};

// ==========================================
// Brick layout
// ==========================================

/**
 * Smooth-surface bricks partition the edge bases `q ∈ [-1, n)` per axis (the
 * `-1` layer closes the surface at the low border), hence `n + 1` positions.
 */
export function surfaceBrickCount(n: number, B: number): number {
  return Math.ceil((n + 1) / B);
}

/** Block bricks partition the voxels `[0, n)` per axis. */
export function blockBrickCount(n: number, B: number): number {
  return Math.ceil(n / B);
}

/** Owned edge-base range `[lo, hi)` of surface brick `i` along one axis. */
function surfaceRange(i: number, n: number, B: number): [number, number] {
  return [i * B - 1, Math.min((i + 1) * B, n + 1) - 1];
}

/** Surface bricks along one axis whose output changes when grid layers
 *  `[g0, g1]` change (cells reading them, and cells whose normals do), as an
 *  inclusive index range, or null. */
export function surfaceBricksInRange(
  g0: number,
  g1: number,
  n: number,
  B: number,
): [number, number] | null {
  let first = -1;
  let last = -1;
  const count = surfaceBrickCount(n, B);
  for (let i = 0; i < count; i++) {
    const [lo, hi] = surfaceRange(i, n, B);
    // Cells [lo-1, hi) read layers [lo-1, hi]; gradients and the blur widen
    // that by 2 on each side.
    if (lo - 3 <= g1 && g0 <= hi + 2) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : [first, last];
}

/** Block bricks along one axis whose faces change when layers `[g0, g1]`
 *  change, as an inclusive index range, or null. */
export function blockBricksInRange(
  g0: number,
  g1: number,
  n: number,
  B: number,
): [number, number] | null {
  let first = -1;
  let last = -1;
  const count = blockBrickCount(n, B);
  for (let i = 0; i < count; i++) {
    const lo = i * B;
    const hi = Math.min(lo + B, n);
    if (lo - 1 <= g1 && g0 <= hi) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : [first, last];
}

// ==========================================
// Growable output buffers
// ==========================================

class F32 {
  data = new Float32Array(1024);
  length = 0;
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) this.grow();
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  private grow(): void {
    const next = new Float32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }
  take(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

class U32 {
  data = new Uint32Array(1024);
  length = 0;
  push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.data.length) this.grow();
    this.data[this.length++] = a;
    this.data[this.length++] = b;
    this.data[this.length++] = c;
  }
  private grow(): void {
    const next = new Uint32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
  }
  take(): Uint32Array {
    return this.data.slice(0, this.length);
  }
}

// ==========================================
// Smooth surface (surface nets on a blurred field)
// ==========================================

/** The 12 cell edges as pairs of corner indices (corner bit order x, y, z). */
const CELL_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
];

/**
 * Mesh surface brick `(bi, bj, bk)` of `grid` with brick size `B`.
 */
export function meshSurfaceBrick(
  grid: Grid,
  B: number,
  bi: number,
  bj: number,
  bk: number,
): BrickMesh {
  const { nx, ny, nz, data } = grid;
  const [lx, hx] = surfaceRange(bi, nx, B);
  const [ly, hy] = surfaceRange(bj, ny, B);
  const [lz, hz] = surfaceRange(bk, nz, B);
  if (hx <= lx || hy <= ly || hz <= lz) return EMPTY_MESH;

  // Cells [lo-1, hi) per axis (cell c spans voxels c..c+1).
  const cx0 = lx - 1, cy0 = ly - 1, cz0 = lz - 1;
  const cxn = hx - cx0, cyn = hy - cy0, czn = hz - cz0;

  // Occupancy on [c0-2, c0+cn+3): cell corners [c0, c0+cn], plus 1 for
  // gradients and 1 for the blur on each side.
  const ox = cx0 - 2, oy = cy0 - 2, oz = cz0 - 2;
  const sx = cxn + 5, sy = cyn + 5, sz = czn + 5;
  const occ = new Float32Array(sx * sy * sz);
  let filled = 0;
  for (let z = 0; z < sz; z++) {
    const gz = oz + z;
    if (gz < 0 || gz >= nz) continue;
    for (let y = 0; y < sy; y++) {
      const gy = oy + y;
      if (gy < 0 || gy >= ny) continue;
      const row = (gz * ny + gy) * nx;
      const out = (z * sy + y) * sx;
      for (let x = 0; x < sx; x++) {
        const gx = ox + x;
        if (gx >= 0 && gx < nx && data[row + gx] !== 0) {
          occ[out + x] = 1;
          filled++;
        }
      }
    }
  }
  // Nothing filled near this brick: no surface. (Fully filled is also
  // surface-free, but that case falls out of the cell test below.)
  if (filled === 0) return EMPTY_MESH;

  const field = boxBlur3(occ, sx, sy, sz);
  const plane = sx * sy;
  const at = (x: number, y: number, z: number) => ((z - oz) * sy + (y - oy)) * sx + (x - ox);
  /** Offsets of the 8 cell corners from corner 0 (bit order x, y, z). */
  const cornerOffset = [0, 1, sx, sx + 1, plane, plane + 1, plane + sx, plane + sx + 1];

  const positions = new F32();
  const normals = new F32();
  const indices = new U32();
  const vertexOf = new Int32Array(cxn * cyn * czn).fill(-1);
  const cellIndex = (x: number, y: number, z: number) =>
    ((z - cz0) * cyn + (y - cy0)) * cxn + (x - cx0);

  const corner = new Float64Array(8);
  const cornerBin = new Uint8Array(8);
  const grad = new Float64Array(24);

  for (let z = cz0; z < hz; z++) {
    for (let y = cy0; y < hy; y++) {
      let i0 = at(cx0, y, z);
      for (let x = cx0; x < hx; x++, i0++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          if (occ[i0 + cornerOffset[c]] !== 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 0xff) continue;

        for (let c = 0; c < 8; c++) {
          const j = i0 + cornerOffset[c];
          cornerBin[c] = (mask >> c) & 1;
          corner[c] = field[j];
          grad[c * 3] = field[j + 1] - field[j - 1];
          grad[c * 3 + 1] = field[j + sx] - field[j - sx];
          grad[c * 3 + 2] = field[j + plane] - field[j - plane];
        }

        // Average the iso-crossings of the edges whose ends disagree.
        let ax = 0, ay = 0, az = 0, n = 0;
        for (let e = 0; e < 12; e++) {
          const [c0, c1] = CELL_EDGES[e];
          if (cornerBin[c0] === cornerBin[c1]) continue;
          const f0 = corner[c0], f1 = corner[c1];
          let t = f1 !== f0 ? (0.5 - f0) / (f1 - f0) : 0.5;
          if (!(t >= 0 && t <= 1)) t = 0.5; // blurred field disagrees: midpoint
          ax += (c0 & 1) + t * ((c1 & 1) - (c0 & 1));
          ay += ((c0 >> 1) & 1) + t * (((c1 >> 1) & 1) - ((c0 >> 1) & 1));
          az += (c0 >> 2) + t * ((c1 >> 2) - (c0 >> 2));
          n++;
        }
        ax /= n; ay /= n; az /= n;

        // Trilinear gradient at the vertex; the surface faces down-gradient.
        let gx = 0, gy = 0, gz = 0;
        for (let c = 0; c < 8; c++) {
          const w =
            ((c & 1) ? ax : 1 - ax) *
            (((c >> 1) & 1) ? ay : 1 - ay) *
            ((c >> 2) ? az : 1 - az);
          gx += w * grad[c * 3];
          gy += w * grad[c * 3 + 1];
          gz += w * grad[c * 3 + 2];
        }
        let len = Math.hypot(gx, gy, gz);
        if (len < 1e-6) {
          // Flat blurred field (thin feature): fall back to the corners.
          gx = gy = gz = 0;
          for (let c = 0; c < 8; c++) {
            const s = cornerBin[c] ? 1 : -1;
            gx += s * ((c & 1) ? 1 : -1);
            gy += s * (((c >> 1) & 1) ? 1 : -1);
            gz += s * ((c >> 2) ? 1 : -1);
          }
          len = Math.hypot(gx, gy, gz) || 1;
        }

        vertexOf[cellIndex(x, y, z)] = positions.length / 3;
        positions.push3(x + ax, y + ay, z + az);
        normals.push3(-gx / len, -gy / len, -gz / len);
      }
    }
  }

  // One quad per owned edge whose ends disagree, joining the 4 cells around
  // it. Wound counter-clockwise seen from the empty side.
  const emitQuad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) {
      indices.push3(a, d, c);
      indices.push3(a, c, b);
    } else {
      indices.push3(a, b, c);
      indices.push3(a, c, d);
    }
  };
  for (let z = lz; z < hz; z++) {
    for (let y = ly; y < hy; y++) {
      let j = at(lx, y, z);
      for (let x = lx; x < hx; x++, j++) {
        const v = occ[j];
        // Edge along x: cells around it vary in (y, z).
        if (y >= 0 && z >= 0 && v !== occ[j + 1]) {
          emitQuad(
            vertexOf[cellIndex(x, y - 1, z - 1)],
            vertexOf[cellIndex(x, y, z - 1)],
            vertexOf[cellIndex(x, y, z)],
            vertexOf[cellIndex(x, y - 1, z)],
            v === 0,
          );
        }
        // Edge along y: cells vary in (z, x).
        if (x >= 0 && z >= 0 && v !== occ[j + sx]) {
          emitQuad(
            vertexOf[cellIndex(x - 1, y, z - 1)],
            vertexOf[cellIndex(x - 1, y, z)],
            vertexOf[cellIndex(x, y, z)],
            vertexOf[cellIndex(x, y, z - 1)],
            v === 0,
          );
        }
        // Edge along z: cells vary in (x, y).
        if (x >= 0 && y >= 0 && v !== occ[j + plane]) {
          emitQuad(
            vertexOf[cellIndex(x - 1, y - 1, z)],
            vertexOf[cellIndex(x, y - 1, z)],
            vertexOf[cellIndex(x, y, z)],
            vertexOf[cellIndex(x - 1, y, z)],
            v === 0,
          );
        }
      }
    }
  }

  if (indices.length === 0) return EMPTY_MESH;
  return { positions: positions.take(), normals: normals.take(), indices: indices.take() };
}

/** Separable 3×3×3 box blur; the outermost layer of the result is invalid. */
function boxBlur3(src: Float32Array, sx: number, sy: number, sz: number): Float32Array {
  const a = new Float32Array(src.length);
  const b = new Float32Array(src.length);
  const plane = sx * sy;
  for (let i = 1; i < src.length - 1; i++) a[i] = src[i - 1] + src[i] + src[i + 1];
  for (let i = sx; i < src.length - sx; i++) b[i] = a[i - sx] + a[i] + a[i + sx];
  for (let i = plane; i < src.length - plane; i++) {
    a[i] = (b[i - plane] + b[i] + b[i + plane]) / 27;
  }
  return a;
}

// ==========================================
// Blocks (greedy-meshed voxel faces)
// ==========================================

/** Mesh block brick `(bi, bj, bk)`: the exact voxel faces of `grid`. */
export function meshBlockBrick(
  grid: Grid,
  B: number,
  bi: number,
  bj: number,
  bk: number,
): BrickMesh {
  const { nx, ny, nz, data } = grid;
  const lo = [bi * B, bj * B, bk * B];
  const hi = [Math.min(lo[0] + B, nx), Math.min(lo[1] + B, ny), Math.min(lo[2] + B, nz)];
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  if (size[0] <= 0 || size[1] <= 0 || size[2] <= 0) return EMPTY_MESH;

  // The brick's voxels plus a one-voxel border (neighbours decide faces).
  const px = size[0] + 2, py = size[1] + 2, pz = size[2] + 2;
  const pad = new Uint8Array(px * py * pz);
  let filled = 0;
  for (let z = 0; z < pz; z++) {
    const gz = lo[2] + z - 1;
    if (gz < 0 || gz >= nz) continue;
    for (let y = 0; y < py; y++) {
      const gy = lo[1] + y - 1;
      if (gy < 0 || gy >= ny) continue;
      const row = (gz * ny + gy) * nx;
      const out = (z * py + y) * px;
      for (let x = 0; x < px; x++) {
        const gx = lo[0] + x - 1;
        if (gx >= 0 && gx < nx && data[row + gx] !== 0) {
          pad[out + x] = 1;
          // Only the brick's own voxels can emit faces.
          if (x > 0 && x <= size[0] && y > 0 && y <= size[1] && z > 0 && z <= size[2]) filled++;
        }
      }
    }
  }
  if (filled === 0) return EMPTY_MESH;

  const stride = [1, px, px * py];
  const origin = stride[0] + stride[1] + stride[2]; // pad index of voxel lo

  const positions = new F32();
  const normals = new F32();
  const indices = new U32();
  const pos = [0, 0, 0];

  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3;
    const v = (axis + 2) % 3;
    const nu = size[u];
    const nv = size[v];
    const sA = stride[axis], sU = stride[u], sV = stride[v];
    const faces = new Uint8Array(nu * nv);

    for (let d = 0; d < size[axis]; d++) {
      for (const dir of [1, -1]) {
        // Faces of layer d looking towards `dir` along the axis.
        let any = false;
        for (let j = 0; j < nv; j++) {
          let idx = origin + d * sA + j * sV;
          for (let i = 0; i < nu; i++, idx += sU) {
            const face = pad[idx] !== 0 && pad[idx + dir * sA] === 0;
            faces[j * nu + i] = face ? 1 : 0;
            if (face) any = true;
          }
        }
        if (!any) continue;

        // Greedy merge into rectangles.
        for (let j = 0; j < nv; j++) {
          for (let i = 0; i < nu; ) {
            if (faces[j * nu + i] === 0) {
              i++;
              continue;
            }
            let w = 1;
            while (i + w < nu && faces[j * nu + i + w] !== 0) w++;
            let h = 1;
            grow: while (j + h < nv) {
              for (let k = 0; k < w; k++) {
                if (faces[(j + h) * nu + i + k] === 0) break grow;
              }
              h++;
            }
            for (let jj = 0; jj < h; jj++) {
              faces.fill(0, (j + jj) * nu + i, (j + jj) * nu + i + w);
            }

            // The face plane sits half a voxel from the voxel centres.
            const plane = lo[axis] + d + dir * 0.5;
            const u0 = lo[u] + i - 0.5, u1 = u0 + w;
            const v0 = lo[v] + j - 0.5, v1 = v0 + h;
            const base = positions.length / 3;
            pos[axis] = plane;
            for (let c = 0; c < 4; c++) {
              pos[u] = c === 1 || c === 2 ? u1 : u0;
              pos[v] = c >= 2 ? v1 : v0;
              positions.push3(pos[0], pos[1], pos[2]);
              normals.push3(axis === 0 ? dir : 0, axis === 1 ? dir : 0, axis === 2 ? dir : 0);
            }
            // (u, v, axis) is right-handed, so u→v runs counter-clockwise seen
            // from +axis.
            if (dir > 0) {
              indices.push3(base, base + 1, base + 2);
              indices.push3(base, base + 2, base + 3);
            } else {
              indices.push3(base, base + 2, base + 1);
              indices.push3(base, base + 3, base + 2);
            }
            i += w;
          }
        }
      }
    }
  }

  if (indices.length === 0) return EMPTY_MESH;
  return { positions: positions.take(), normals: normals.take(), indices: indices.take() };
}

// ==========================================
// Downsampling
// ==========================================

/**
 * Occupancy grid of `D` full-resolution slices at level-of-detail `lod`: a
 * grid voxel is filled when any voxel of its `lod³` block is (so thin
 * structures survive). Writes grid layers `[gz0, gz0 + ceil(D/lod))` of `out`
 * from `slab`, which holds full-res slices starting at `gz0 * lod`.
 */
export function downsampleSlab(
  slab: Uint8Array,
  width: number,
  height: number,
  lod: number,
  out: Grid,
  gz0: number,
): void {
  const slices = slab.length / (width * height);
  const layers = Math.ceil(slices / lod);
  const { nx, ny } = out;
  for (let l = 0; l < layers && gz0 + l < out.nz; l++) {
    const layer = out.data.subarray((gz0 + l) * nx * ny, (gz0 + l + 1) * nx * ny);
    layer.fill(0);
    const zEnd = Math.min((l + 1) * lod, slices);
    for (let z = l * lod; z < zEnd; z++) {
      for (let y = 0; y < height; y++) {
        const src = (z * height + y) * width;
        const dst = Math.floor(y / lod) * nx;
        for (let x = 0; x < width; x++) {
          if (slab[src + x] !== 0) layer[dst + Math.floor(x / lod)] = 1;
        }
      }
    }
  }
}
