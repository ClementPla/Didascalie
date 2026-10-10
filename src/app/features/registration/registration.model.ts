// ── Geometry primitives ────────────────────────────────────────────────────

export interface Point2D {
  x: number;
  y: number;
}

// ── Correspondence pairs ───────────────────────────────────────────────────

export interface CorrespondencePair {
  id: string;
  /** In the reference image, native pixels. */
  ref: Point2D;
  /** In the moving image, native pixels. */
  moving: Point2D;
}

export function makePair(ref: Point2D, moving: Point2D): CorrespondencePair {
  return { id: crypto.randomUUID(), ref: { ...ref }, moving: { ...moving } };
}

// ── Transforms ─────────────────────────────────────────────────────────────

export interface IdentityTransform { type: 'identity'; }

export interface HomographyTransform {
  type: 'homography';
  matrix: [number, number, number,
           number, number, number,
           number, number, number];
}

/** Reserved; not implemented in this build. */
export interface TPSTransform {
  type: 'tps';
  controlPoints: CorrespondencePair[];
  lambda: number;
}

/** Reserved; not implemented in this build. */
export interface BSplineGridTransform {
  type: 'bspline-grid';
  gridW: number;
  gridH: number;
  displacements: Float32Array;
}

export type Transform2D =
  | IdentityTransform
  | HomographyTransform
  | TPSTransform
  | BSplineGridTransform;

export const IDENTITY: IdentityTransform = { type: 'identity' };
// ── Registration state (per moving frame) ──────────────────────────────────

export interface FrameRegistration {
  referenceFrameId: string;
  movingFrameId:    string;
  pairs:     CorrespondencePair[];
  transform: Transform2D;
}

export function makeRegistration(referenceFrameId: string, movingFrameId: string): FrameRegistration {
  return { referenceFrameId, movingFrameId, pairs: [], transform: IDENTITY };
}

export function fitHomography(pairs: CorrespondencePair[]): HomographyTransform | null {
  if (pairs.length < 4) return null;

  const refPts    = pairs.map(p => p.ref);
  const movingPts = pairs.map(p => p.moving);

  const refNorm    = hartleyNormalize(refPts);
  const movingNorm = hartleyNormalize(movingPts);
  if (!refNorm || !movingNorm) return null;

  const n = pairs.length;
  const A = new Float64Array(2 * n * 9);
  for (let i = 0; i < n; i++) {
    const x  = movingNorm.points[i].x;
    const y  = movingNorm.points[i].y;
    const xp = refNorm.points[i].x;
    const yp = refNorm.points[i].y;
    const r0 = i * 18;
    A[r0 + 0] = 0;        A[r0 + 1] = 0;        A[r0 + 2] = 0;
    A[r0 + 3] = -x;       A[r0 + 4] = -y;       A[r0 + 5] = -1;
    A[r0 + 6] = yp * x;   A[r0 + 7] = yp * y;   A[r0 + 8] = yp;
    const r1 = r0 + 9;
    A[r1 + 0] = x;        A[r1 + 1] = y;        A[r1 + 2] = 1;
    A[r1 + 3] = 0;        A[r1 + 4] = 0;        A[r1 + 5] = 0;
    A[r1 + 6] = -xp * x;  A[r1 + 7] = -xp * y;  A[r1 + 8] = -xp;
  }

  // M = AᵀA (9×9 symmetric).
  const M = new Float64Array(81);
  for (let i = 0; i < 9; i++) {
    for (let j = i; j < 9; j++) {
      let s = 0;
      for (let k = 0; k < 2 * n; k++) {
        s += A[k * 9 + i] * A[k * 9 + j];
      }
      M[i * 9 + j] = s;
      M[j * 9 + i] = s;
    }
  }

  const h = smallestEigenvector9(M);
  if (!h) return null;

  const Hn: Matrix3x3 = [
    h[0], h[1], h[2],
    h[3], h[4], h[5],
    h[6], h[7], h[8],
  ];

  // Denormalize:  H = T_ref⁻¹ · Hn · T_moving
  const TrefInv = invert3x3(refNorm.T);
  if (!TrefInv) return null;
  const Hd = mul3x3(mul3x3(TrefInv, Hn), movingNorm.T);

  // Divide by h22, or by the largest entry when h22 ≈ 0.
  let denom = Hd[8];
  if (Math.abs(denom) < 1e-12) {
    denom = Hd.reduce((m, v) => Math.abs(v) > Math.abs(m) ? v : m, Hd[0]);
  }
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-15) return null;

  return {
    type: 'homography',
    matrix: Hd.map(v => v / denom) as Matrix3x3,
  };
}

// ── Application ────────────────────────────────────────────────────────────

export function applyTransform(t: Transform2D, p: Point2D): Point2D {
  if (t.type === 'homography') {
    const [a, b, c, d, e, f, g, h, i] = t.matrix;
    const w = g * p.x + h * p.y + i;
    if (Math.abs(w) < 1e-12) return { ...p }; // point at infinity → identity fallback
    return {
      x: (a * p.x + b * p.y + c) / w,
      y: (d * p.x + e * p.y + f) / w,
    };
  }
  return { ...p };
}

export function invertHomography(t: HomographyTransform): HomographyTransform | null {
  const inv = invert3x3(t.matrix);
  if (!inv) return null;
  const denom = Math.abs(inv[8]) > 1e-12 ? inv[8] : 1;
  return {
    type: 'homography',
    matrix: inv.map(v => v / denom) as Matrix3x3,
  };
}

/**
 * A 3×3 homography as a CSS `matrix3d(...)` string, z passing through:
 *
 *   [ h00  h01   0   h02 ]
 *   [ h10  h11   0   h12 ]
 *   [  0    0    1    0  ]
 *   [ h20  h21   0   h22 ]
 */
export function homographyToCssMatrix3d(t: HomographyTransform): string {
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = t.matrix;
  // matrix3d args are column-major.
  return `matrix3d(${h00}, ${h10}, 0, ${h20}, ` +
                 `${h01}, ${h11}, 0, ${h21}, ` +
                 `0, 0, 1, 0, ` +
                 `${h02}, ${h12}, 0, ${h22})`;
}

// ── Fit residuals (for UI feedback) ────────────────────────────────────────

export interface FitResidual {
  pairId: string;
  /** Distance between predicted and actual, in reference-image px. */
  error: number;
}

export interface FitSummary {
  residuals: FitResidual[];
  /** In reference-image px. */
  rmse: number;
  maxError: number;
}

export function computeResiduals(t: Transform2D, pairs: CorrespondencePair[]): FitSummary {
  if (pairs.length === 0) return { residuals: [], rmse: 0, maxError: 0 };
  const residuals: FitResidual[] = [];
  let sqSum = 0;
  let maxError = 0;
  for (const p of pairs) {
    const pred = applyTransform(t, p.moving);
    const dx = pred.x - p.ref.x;
    const dy = pred.y - p.ref.y;
    const err = Math.hypot(dx, dy);
    residuals.push({ pairId: p.id, error: err });
    sqSum += err * err;
    if (err > maxError) maxError = err;
  }
  return {
    residuals,
    rmse: Math.sqrt(sqSum / pairs.length),
    maxError,
  };
}

// ── Internals ──────────────────────────────────────────────────────────────

type Matrix3x3 = [number, number, number,
                  number, number, number,
                  number, number, number];

/**
 * Hartley normalization: translate to the centroid and scale so the mean
 * distance from the origin is √2. Returns the points and the similarity `T`
 * with `normalized = T · original`, or null if all points coincide.
 */
function hartleyNormalize(points: Point2D[]): {
  points: Point2D[];
  T: Matrix3x3;
} | null {
  const n = points.length;
  let cx = 0, cy = 0;
  for (const p of points) { cx += p.x; cy += p.y; }
  cx /= n; cy /= n;

  let mean = 0;
  for (const p of points) {
    mean += Math.hypot(p.x - cx, p.y - cy);
  }
  mean /= n;
  if (mean < 1e-12) return null;

  const s = Math.SQRT2 / mean;
  const T: Matrix3x3 = [
    s, 0, -s * cx,
    0, s, -s * cy,
    0, 0, 1,
  ];
  const normalized = points.map(p => ({
    x: s * (p.x - cx),
    y: s * (p.y - cy),
  }));
  return { points: normalized, T };
}

function mul3x3(A: Matrix3x3, B: Matrix3x3): Matrix3x3 {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] =
        A[i * 3]     * B[j] +
        A[i * 3 + 1] * B[3 + j] +
        A[i * 3 + 2] * B[6 + j];
    }
  }
  return r as Matrix3x3;
}

function invert3x3(M: Matrix3x3): Matrix3x3 | null {
  const [a, b, c, d, e, f, g, h, i] = M;
  const A =  (e * i - f * h);
  const B = -(d * i - f * g);
  const C =  (d * h - e * g);
  const D = -(b * i - c * h);
  const E =  (a * i - c * g);
  const F = -(a * h - b * g);
  const G =  (b * f - c * e);
  const H = -(a * f - c * d);
  const I =  (a * e - b * d);
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  const invDet = 1 / det;
  return [
    A * invDet, D * invDet, G * invDet,
    B * invDet, E * invDet, H * invDet,
    C * invDet, F * invDet, I * invDet,
  ];
}

/**
 * Smallest eigenvector of a 9×9 symmetric matrix, by inverse power iteration
 * on the matrix shifted by a small σ (LU with partial pivoting).
 */
function smallestEigenvector9(M: Float64Array): Float64Array | null {
  const SIZE = 9;
  const sigma = 1e-9;
  const LU = new Float64Array(M);
  for (let i = 0; i < SIZE; i++) LU[i * SIZE + i] += sigma;

  const piv = new Int32Array(SIZE);
  for (let i = 0; i < SIZE; i++) piv[i] = i;

  for (let k = 0; k < SIZE; k++) {
    let maxAbs = Math.abs(LU[k * SIZE + k]);
    let maxRow = k;
    for (let i = k + 1; i < SIZE; i++) {
      const v = Math.abs(LU[i * SIZE + k]);
      if (v > maxAbs) { maxAbs = v; maxRow = i; }
    }
    if (maxAbs < 1e-15) return null;
    if (maxRow !== k) {
      for (let j = 0; j < SIZE; j++) {
        const t = LU[k * SIZE + j];
        LU[k * SIZE + j] = LU[maxRow * SIZE + j];
        LU[maxRow * SIZE + j] = t;
      }
      const t = piv[k]; piv[k] = piv[maxRow]; piv[maxRow] = t;
    }
    const akk = LU[k * SIZE + k];
    for (let i = k + 1; i < SIZE; i++) {
      const factor = LU[i * SIZE + k] / akk;
      LU[i * SIZE + k] = factor;
      for (let j = k + 1; j < SIZE; j++) {
        LU[i * SIZE + j] -= factor * LU[k * SIZE + j];
      }
    }
  }

  const solve = (b: Float64Array): Float64Array => {
    const y = new Float64Array(SIZE);
    for (let i = 0; i < SIZE; i++) y[i] = b[piv[i]];
    for (let i = 1; i < SIZE; i++) {
      let s = y[i];
      for (let j = 0; j < i; j++) s -= LU[i * SIZE + j] * y[j];
      y[i] = s;
    }
    const x = new Float64Array(SIZE);
    for (let i = SIZE - 1; i >= 0; i--) {
      let s = y[i];
      for (let j = i + 1; j < SIZE; j++) s -= LU[i * SIZE + j] * x[j];
      x[i] = s / LU[i * SIZE + i];
    }
    return x;
  };

  let v = new Float64Array(SIZE);
  v.fill(1 / Math.sqrt(SIZE));
  normalize(v);

  for (let iter = 0; iter < 50; iter++) {
    const next = solve(v);
    normalize(next);
    let dot = 0;
    for (let i = 0; i < SIZE; i++) dot += next[i] * v[i];
    if (Math.abs(Math.abs(dot) - 1) < 1e-8) return next;
    v = next as Float64Array<ArrayBuffer>;
  }
  return v;
}

function normalize(v: Float64Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  if (s < 1e-15) return;
  for (let i = 0; i < v.length; i++) v[i] /= s;
}