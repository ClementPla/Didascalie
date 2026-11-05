/**
 * Outline display of a label layer, on the CPU: each label's fill and its
 * contour band get their own opacity, and the band is `radius` grid pixels
 * thick, inside the shape.
 *
 * A pixel is interior when every pixel within an octagon around it holds the
 * same value: `radius` along the axes, `diagonalReach(radius)` along the
 * diagonals, so the band keeps about the same thickness at every angle. The
 * test is exact and costs O(1) per pixel whatever the radius: row and column
 * run lengths, the octagon being the union of a cross and a square.
 */

export interface OutlineStyle {
  /** Opacity of the interior, 0..1. 0 hides it. */
  fillAlpha: number;
  /** Opacity of the contour band, 0..1. 0 hides it. */
  contourAlpha: number;
  /** Band thickness in grid pixels, ≥ 1. */
  radius: number;
}

/** Largest radius drawn: past it the GPU test gets too costly. */
export const MAX_OUTLINE_RADIUS = 32;

/** Reach of the octagon along the diagonals, in steps of one diagonal pixel.
 *  Radius 1 is the plain 4-neighbour test. */
export function diagonalReach(radius: number): number {
  return radius > 1 ? Math.round(radius / Math.SQRT2) : 0;
}

/** Reusable work buffers, so a redraw allocates nothing. */
export class OutlineScratch {
  hrun = new Uint8Array(0);
  ueq = new Uint8Array(0);
  uq = new Uint8Array(0);
  deq = new Uint8Array(0);
  dq = new Uint8Array(0);

  ensure(w: number, h: number): void {
    const n = w * h;
    if (this.hrun.length < n) {
      this.hrun = new Uint8Array(n);
      this.ueq = new Uint8Array(n);
      this.uq = new Uint8Array(n);
    }
    if (this.deq.length < w) {
      this.deq = new Uint8Array(w);
      this.dq = new Uint8Array(w);
    }
  }
}

/**
 * Blend one label layer over `data` (straight-alpha RGBA, `w*h`), its colours
 * from the 256-entry RGBA palette `pal`. Later layers go over earlier ones;
 * the outside of the grid counts as a different value.
 */
export function paintLayerOutlined(
  data: Uint8ClampedArray,
  src: Uint8Array,
  pal: Uint8Array,
  w: number,
  h: number,
  style: OutlineStyle,
  scratch: OutlineScratch
): void {
  const fillA = Math.round(Math.max(0, Math.min(1, style.fillAlpha)) * 255);
  const lineA = Math.round(Math.max(0, Math.min(1, style.contourAlpha)) * 255);
  if (fillA === 0 && lineA === 0) return;

  // Without a contour every labelled pixel is fill.
  if (lineA === 0) {
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (v !== 0) blend(data, i * 4, pal, v * 4, fillA);
    }
    return;
  }

  const r = Math.max(1, Math.min(MAX_OUTLINE_RADIUS, Math.round(style.radius)));

  // Radius 1: the plain 4-neighbour test, one pass.
  if (r === 1) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const yInside = y > 0 && y < h - 1;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        const v = src[i];
        if (v === 0) continue;
        const interior =
          yInside && x > 0 && x < w - 1 &&
          src[i - 1] === v && src[i + 1] === v && src[i - w] === v && src[i + w] === v;
        const a = interior ? fillA : lineA;
        if (a !== 0) blend(data, i * 4, pal, v * 4, a);
      }
    }
    return;
  }

  const s = diagonalReach(r);
  scratch.ensure(w, h);
  const { hrun, ueq, uq, deq, dq } = scratch;

  // Top-down sweep, over labelled pixels only. Per run of equal pixels in a
  // row: hrun = equal pixels on the shorter side. Then from the row above:
  // equal pixels above (ueq), and those of them whose row reaches the
  // square's half-width (uq).
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let x = 0;
    while (x < w) {
      const v = src[row + x];
      if (v === 0) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < w && src[row + end] === v) end++;
      for (let k = x; k < end; k++) {
        const i = row + k;
        const d = Math.min(k - x, end - 1 - k);
        hrun[i] = d < 255 ? d : 255;
        const j = i - w;
        if (y > 0 && src[j] === v) {
          const e = ueq[j];
          ueq[i] = e < 255 ? e + 1 : 255;
          const q = uq[j];
          uq[i] = hrun[j] >= s ? (q < 255 ? q + 1 : 255) : 0;
        } else {
          ueq[i] = 0;
          uq[i] = 0;
        }
      }
      x = end;
    }
  }

  // Bottom-up sweep: the same below, kept per column (only read under an
  // equal pixel, which set it the row before), then paint.
  for (let y = h - 1; y >= 0; y--) {
    const row = y * w;
    const last = y === h - 1;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const v = src[i];
      if (v === 0) continue;
      let de = 0;
      let dqv = 0;
      if (!last && src[i + w] === v) {
        de = deq[x] < 255 ? deq[x] + 1 : 255;
        dqv = hrun[i + w] >= s ? (dq[x] < 255 ? dq[x] + 1 : 255) : 0;
      }
      deq[x] = de;
      dq[x] = dqv;

      const interior =
        hrun[i] >= r && ueq[i] >= r && de >= r && uq[i] >= s && dqv >= s;
      const a = interior ? fillA : lineA;
      if (a !== 0) blend(data, i * 4, pal, v * 4, a);
    }
  }
}

/** `pal[p..]` at opacity `a` (0..255) over `data[o..]`. */
function blend(data: Uint8ClampedArray, o: number, pal: Uint8Array, p: number, a: number): void {
  const da = data[o + 3];
  if (a === 255 || da === 0) {
    data[o] = pal[p];
    data[o + 1] = pal[p + 1];
    data[o + 2] = pal[p + 2];
    data[o + 3] = a;
    return;
  }
  // Straight-alpha "over", in 0..255 units.
  const keep = (da * (255 - a)) / 255;
  const oa = a + keep;
  data[o] = (pal[p] * a + data[o] * keep) / oa;
  data[o + 1] = (pal[p + 1] * a + data[o + 1] * keep) / oa;
  data[o + 2] = (pal[p + 2] * a + data[o + 2] * keep) / oa;
  data[o + 3] = oa;
}
