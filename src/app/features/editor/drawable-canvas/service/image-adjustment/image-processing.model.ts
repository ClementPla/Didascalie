export type Channel = 'r' | 'g' | 'b' | 'luma';
export const CHANNELS: Channel[] = ['r', 'g', 'b', 'luma'];

/** Input intensity → output intensity, both in [0, 255]. */
export interface CurveNode {
  x: number;
  y: number;
}

export type CurvePoints = CurveNode[];

/**
 * - brightness: [-100, +100], 0 = identity
 * - contrast:   [-100, +100], 0 = identity
 * - gamma:      [0.1, 3.0], 1.0 = identity
 * - curve:      monotone array of CurveNodes
 */
export interface ChannelAdjustments {
  brightness: number;
  contrast: number;
  gamma: number;
  curve: CurvePoints;
}

export interface AdjustmentState {
  r: ChannelAdjustments;
  g: ChannelAdjustments;
  b: ChannelAdjustments;
  luma: ChannelAdjustments;
}

export const IDENTITY_CURVE: CurvePoints = [
  { x: 0, y: 0 },
  { x: 85, y: 85 },
  { x: 170, y: 170 },
  { x: 255, y: 255 },
];

export function makeIdentityAdjustments(): ChannelAdjustments {
  return {
    brightness: 0,
    contrast: 0,
    gamma: 1,
    curve: IDENTITY_CURVE.map(p => ({ ...p })),
  };
}

export function makeIdentityState(): AdjustmentState {
  return {
    r:    makeIdentityAdjustments(),
    g:    makeIdentityAdjustments(),
    b:    makeIdentityAdjustments(),
    luma: makeIdentityAdjustments(),
  };
}

export function isIdentity(state: AdjustmentState): boolean {
  return CHANNELS.every(ch => isIdentityAdj(state[ch]));
}

function isIdentityAdj(a: ChannelAdjustments): boolean {
  if (a.brightness !== 0 || a.contrast !== 0 || a.gamma !== 1) return false;
  if (a.curve.length !== IDENTITY_CURVE.length) return false;
  return a.curve.every((p, i) => p.x === IDENTITY_CURVE[i].x && p.y === IDENTITY_CURVE[i].y);
}

// ── LUT ────────────────────────────────────────────────────────────────────

/** Index 0..255 → output 0..255. */
export type ChannelLUT = Uint8Array;

export interface RGBLUT {
  r: ChannelLUT;
  g: ChannelLUT;
  b: ChannelLUT;
}

export function identityLUT(): ChannelLUT {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = i;
  return lut;
}

// ── LUT composition ────────────────────────────────────────────────────────

/**
 * One channel's LUT: brightness (additive), contrast (around 128), gamma,
 * then curve.
 */
export function buildChannelLUT(adj: ChannelAdjustments): ChannelLUT {
  const lut = new Uint8Array(256);
  // Slider [-100, +100] → multiplier, by the usual formula.
  const c = (259 * (adj.contrast + 255)) / (255 * (259 - adj.contrast));
  const b = adj.brightness * 2.55;   // [-100,+100] → [-255,+255]
  const invGamma = 1.0 / Math.max(0.01, adj.gamma);
  const curve = sampleCurve(adj.curve);

  for (let i = 0; i < 256; i++) {
    let v = i + b;                                  // brightness
    v = c * (v - 128) + 128;                        // contrast
    v = clamp255(v);
    v = 255 * Math.pow(v / 255, invGamma);          // gamma
    v = clamp255(v);
    v = curve[clamp255i(Math.round(v))];            // curve
    lut[i] = clamp255i(Math.round(v));
  }
  return lut;
}

/**
 * Compose the per-channel LUTs and the luma LUT into R, G, B LUTs. The luma
 * LUT is applied after, identically to the three channels: a simplification
 * that avoids an RGB→YCbCr→RGB round trip.
 */
export function composeRGBLUT(state: AdjustmentState): RGBLUT {
  const r = buildChannelLUT(state.r);
  const g = buildChannelLUT(state.g);
  const b = buildChannelLUT(state.b);
  const luma = buildChannelLUT(state.luma);

  const out: RGBLUT = {
    r: new Uint8Array(256),
    g: new Uint8Array(256),
    b: new Uint8Array(256),
  };
  for (let i = 0; i < 256; i++) {
    out.r[i] = luma[r[i]];
    out.g[i] = luma[g[i]];
    out.b[i] = luma[b[i]];
  }
  return out;
}

/** Pack the LUTs into 256*4 bytes: `[r0,g0,b0,255, r1,g1,b1,255, ...]`. */
export function packRGBLUT(lut: RGBLUT): Uint8Array {
  const packed = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const o = i * 4;
    packed[o]     = lut.r[i];
    packed[o + 1] = lut.g[i];
    packed[o + 2] = lut.b[i];
    packed[o + 3] = 255;
  }
  return packed;
}

// ── Curve sampling (monotone cubic) ────────────────────────────────────────

/**
 * Sample a curve at every integer x in [0, 255] by monotone cubic
 * interpolation (Fritsch–Carlson), which does not overshoot.
 */
export function sampleCurve(nodes: CurvePoints): Uint8Array {
  const pts = [...nodes].sort((a, b) => a.x - b.x);
  // Adjacent nodes with the same x would zero a divisor.
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].x <= pts[i - 1].x) pts[i].x = pts[i - 1].x + 1;
  }
  const n = pts.length;
  if (n < 2) return identityLUT();

  // Secants and tangents (Fritsch–Carlson)
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    d[i] = (pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x);
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else m[i] = (d[i - 1] + d[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i]     = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }

  const out = new Uint8Array(256);
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    while (seg < n - 2 && x > pts[seg + 1].x) seg++;
    const x0 = pts[seg].x, x1 = pts[seg + 1].x;
    const y0 = pts[seg].y, y1 = pts[seg + 1].y;
    const h = x1 - x0;
    if (x <= x0) { out[x] = clamp255i(Math.round(y0)); continue; }
    if (x >= x1) { out[x] = clamp255i(Math.round(y1)); continue; }
    const t = (x - x0) / h;
    const t2 = t * t, t3 = t2 * t;
    const h00 =  2 * t3 - 3 * t2 + 1;
    const h10 =      t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 =      t3 -     t2;
    const y = h00 * y0 + h10 * h * m[seg] + h01 * y1 + h11 * h * m[seg + 1];
    out[x] = clamp255i(Math.round(y));
  }
  return out;
}

// ── Histogram ──────────────────────────────────────────────────────────────

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Rec. 709 luma. */
  luma: Uint32Array;
  total: number;
}

export function computeHistogram(imageData: ImageData): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);
  const data = imageData.data;
  const total = (data.length / 4) | 0;

  for (let i = 0; i < data.length; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[R]++; g[G]++; b[B]++;
    const Y = (R * 54 + G * 183 + B * 19) >> 8;
    luma[Y]++;
  }
  return { r, g, b, luma, total };
}

/** The smallest intensity whose CDF reaches `p` (in [0, 1]). */
export function percentile(hist: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let cum = 0;
  for (let i = 0; i < 256; i++) {
    cum += hist[i];
    if (cum >= target) return i;
  }
  return 255;
}

// ── Auto-stretch & equalize ────────────────────────────────────────────────

/**
 * Brightness and contrast slider values mapping the [lo, hi] percentile range
 * of a channel to [0, 255].
 */
export function autoStretchAdjustment(
  hist: Uint32Array,
  total: number,
  loPct = 0.05,
  hiPct = 0.95
): { brightness: number; contrast: number } {
  const lo = percentile(hist, total, loPct);
  const hi = percentile(hist, total, hiPct);
  if (hi <= lo) return { brightness: 0, contrast: 0 };

  // Shift the centre of [lo, hi] to 128, then stretch by 255 / (hi - lo).
  const center = (lo + hi) / 2;
  const brightnessRaw = 128 - center;                    // in 0..255 units
  const cTarget = 255 / (hi - lo);                       // desired multiplier
  // Invert c = (259*(s+255)) / (255*(259-s)).
  const s = (255 * (259 * cTarget - 259)) / (259 * cTarget + 255);

  return {
    brightness: clamp(brightnessRaw / 2.55, -100, 100), // 0..255 units → slider
    contrast:   clamp(s, -100, 100),
  };
}

/** A 4-node curve approximating the equalization of the histogram. */
export function equalizeCurve(hist: Uint32Array, total: number): CurvePoints {
  const cdf = new Uint32Array(256);
  let cum = 0;
  for (let i = 0; i < 256; i++) { cum += hist[i]; cdf[i] = cum; }
  // First non-zero CDF value.
  let cdfMin = 0;
  for (let i = 0; i < 256; i++) if (cdf[i] !== 0) { cdfMin = cdf[i]; break; }
  const denom = Math.max(1, total - cdfMin);

  const remap = (i: number) =>
    clamp255i(Math.round(((cdf[i] - cdfMin) / denom) * 255));

  return [
    { x: 0,   y: remap(0)   },
    { x: 85,  y: remap(85)  },
    { x: 170, y: remap(170) },
    { x: 255, y: remap(255) },
  ];
}

// ── Utilities ──────────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}
function clamp255i(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}