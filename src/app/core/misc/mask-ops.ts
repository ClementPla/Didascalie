/**
 * Whole-mask operations of the Boolean panel, on one label's `w×h` value mask
 * (0 = background; 1 for a semantic label, 1..=255 for instances).
 *
 * The morphology works one value at a time, in a crop around that value, so
 * instances stay apart: an instance never grows over another, and a hole is a
 * hole of one instance. Out of the image counts as "same as the edge": a label
 * touching the border does not erode or smooth away from it.
 */

// ── Label-level operations ──────────────────────────────────────────────────

/** The label becomes its complement over the whole image. */
export function invertWhole(mask: Uint8Array, value: number): void {
  for (let i = 0; i < mask.length; i++) mask[i] = mask[i] !== 0 ? 0 : value;
}

/** The label takes the pixels no label covers and gives up its own. */
export function invertInUnlabelled(masks: Uint8Array[], index: number, value: number): void {
  const mask = masks[index];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 0) {
      mask[i] = 0;
      continue;
    }
    let free = true;
    for (let m = 0; m < masks.length; m++) {
      if (m !== index && masks[m][i] !== 0) {
        free = false;
        break;
      }
    }
    if (free) mask[i] = value;
  }
}

/** Clear, in every other label, the pixels label `index` covers. */
export function subtractFromOthers(masks: Uint8Array[], index: number): void {
  const mask = masks[index];
  for (let m = 0; m < masks.length; m++) {
    if (m === index) continue;
    const other = masks[m];
    for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) other[i] = 0;
  }
}

/**
 * Label `self` went from `before` to its current mask: take the pixels it
 * gained from every other label that had them in `originals` (the masks before
 * the operation). A pixel two labels both gained stays with both.
 */
export function takeAddedFromOthers(
  before: Uint8Array,
  masks: Uint8Array[],
  originals: Uint8Array[],
  self: number,
): void {
  const after = masks[self];
  for (let i = 0; i < after.length; i++) {
    if (after[i] === 0 || before[i] !== 0) continue;
    for (let m = 0; m < masks.length; m++) {
      if (m !== self && originals[m][i] !== 0) masks[m][i] = 0;
    }
  }
}

// ── Morphology ──────────────────────────────────────────────────────────────

/** Grow by `radius` pixels (Euclidean). */
export function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const r = Math.ceil(radius);
  return perValue(mask, w, h, r, (p, cw, ch) => {
    const d = distanceTo(p, cw, ch, 1);
    const out = new Uint8Array(p.length);
    const r2 = radius * radius;
    for (let i = 0; i < p.length; i++) out[i] = d[i] <= r2 ? 1 : 0;
    return out;
  }, true);
}

/** Shrink by `radius` pixels (Euclidean). */
export function erode(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  if (radius <= 0) return mask.slice();
  const r = Math.ceil(radius);
  return perValue(mask, w, h, r + 1, (p, cw, ch) => {
    const d = distanceTo(p, cw, ch, 0);
    const out = new Uint8Array(p.length);
    const r2 = radius * radius;
    for (let i = 0; i < p.length; i++) out[i] = p[i] && d[i] > r2 ? 1 : 0;
    return out;
  });
}

/** Fill the holes up to `maxArea` pixels (Infinity: every hole). A hole is
 *  background enclosed by the label; what reaches the image edge is not. */
export function fillHoles(mask: Uint8Array, w: number, h: number, maxArea: number): Uint8Array {
  return perValue(mask, w, h, 1, (p, cw, ch) => {
    const out = p.slice();
    // Background components, 4-connected (the label is 8-connected).
    const seen = new Uint8Array(p.length);
    const stack: number[] = [];
    const component: number[] = [];
    for (let start = 0; start < p.length; start++) {
      if (p[start] || seen[start]) continue;
      let touchesEdge = false;
      component.length = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        component.push(i);
        const x = i % cw;
        const y = (i - x) / cw;
        if (x === 0 || y === 0 || x === cw - 1 || y === ch - 1) touchesEdge = true;
        if (x > 0 && !p[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
        if (x < cw - 1 && !p[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
        if (y > 0 && !p[i - cw] && !seen[i - cw]) { seen[i - cw] = 1; stack.push(i - cw); }
        if (y < ch - 1 && !p[i + cw] && !seen[i + cw]) { seen[i + cw] = 1; stack.push(i + cw); }
      }
      if (!touchesEdge && component.length <= maxArea) {
        for (const i of component) out[i] = 1;
      }
    }
    return out;
  });
}

/** Remove the pieces of at most `maxArea` pixels (8-connected). */
export function removeIslands(mask: Uint8Array, w: number, h: number, maxArea: number): Uint8Array {
  return perValue(mask, w, h, 0, (p, cw, ch) => {
    const out = p.slice();
    for (const piece of components(p, cw, ch)) {
      if (piece.length <= maxArea) for (const i of piece) out[i] = 0;
    }
    return out;
  });
}

/** Keep only the largest piece (8-connected) of each value. */
export function keepLargest(mask: Uint8Array, w: number, h: number): Uint8Array {
  return perValue(mask, w, h, 0, (p, cw, ch) => {
    const pieces = components(p, cw, ch);
    const out = new Uint8Array(p.length);
    let largest: number[] = [];
    for (const piece of pieces) if (piece.length > largest.length) largest = piece;
    for (const i of largest) out[i] = 1;
    return out;
  });
}

/** Round off the outline: Gaussian blur of the label, kept where above half.
 *  Bumps and dents narrower than about `sigma` go. */
export function smooth(mask: Uint8Array, w: number, h: number, sigma: number): Uint8Array {
  if (sigma <= 0) return mask.slice();
  const kernel = gaussianKernel(sigma);
  const pad = (kernel.length - 1) / 2;
  return perValue(mask, w, h, pad + 1, (p, cw, ch) => {
    // Edge values replicated: at the image edge the label carries on, and a
    // crop edge inside the image is background anyway (the padding).
    const f = new Float32Array(p.length);
    for (let i = 0; i < p.length; i++) f[i] = p[i];
    const tmp = new Float32Array(p.length);
    convolve(f, tmp, cw, ch, kernel, true);
    convolve(tmp, f, cw, ch, kernel, false);
    const out = new Uint8Array(p.length);
    for (let i = 0; i < p.length; i++) out[i] = f[i] > 0.5 ? 1 : 0;
    return out;
  }, true);
}

// ── Gaps ────────────────────────────────────────────────────────────────────

/**
 * Fill the gaps between labels that nearly touch: an unlabelled pixel whose
 * distances to the nearest label (d1) and to the nearest *other* label (d2)
 * add up to at most `gap + 1` goes to the nearest one. Outer edges, with no
 * second label close by, do not grow, and each gap is split at its midline.
 *
 * Every label counts as a neighbour; only `targets` receive pixels. With
 * `betweenInstances`, two instances of one label count as different.
 */
export function fillGaps(
  masks: Uint8Array[],
  w: number,
  h: number,
  gap: number,
  targets: readonly number[],
  betweenInstances: boolean,
): void {
  if (gap <= 0 || masks.length === 0) return;
  const n = w * h;
  const limit = gap + 1;
  const pad = Math.ceil(limit) + 1;
  const d1 = new Float32Array(n).fill(Infinity);
  const d2 = new Float32Array(n).fill(Infinity);
  const group1 = new Int32Array(n).fill(-1);
  const label1 = new Int16Array(n).fill(-1);
  const value1 = new Uint8Array(n);

  let group = 0;
  masks.forEach((mask, label) => {
    const boxes = valueBoxes(mask, w, h);
    if (!betweenInstances) group++;
    for (const [value, box] of boxes) {
      if (betweenInstances) group++;
      const x0 = Math.max(0, box.x0 - pad);
      const y0 = Math.max(0, box.y0 - pad);
      const cw = Math.min(w - 1, box.x1 + pad) - x0 + 1;
      const ch = Math.min(h - 1, box.y1 + pad) - y0 + 1;
      const presence = new Uint8Array(cw * ch);
      for (let y = 0; y < ch; y++) {
        const row = (y0 + y) * w + x0;
        for (let x = 0; x < cw; x++) presence[y * cw + x] = mask[row + x] === value ? 1 : 0;
      }
      const dist = distanceTo(presence, cw, ch, 1);
      for (let y = 0; y < ch; y++) {
        for (let x = 0; x < cw; x++) {
          const sq = dist[y * cw + x];
          if (sq === 0 || sq > limit * limit) continue;
          const d = Math.sqrt(sq);
          const i = (y0 + y) * w + x0 + x;
          // Keep the nearest, and the nearest of another group.
          if (group1[i] === group) {
            if (d < d1[i]) {
              d1[i] = d;
              label1[i] = label;
              value1[i] = value;
            }
          } else if (d < d1[i]) {
            d2[i] = d1[i];
            d1[i] = d;
            group1[i] = group;
            label1[i] = label;
            value1[i] = value;
          } else if (d < d2[i]) {
            d2[i] = d;
          }
        }
      }
    }
  });

  const receives = new Set(targets);
  for (let i = 0; i < n; i++) {
    if (d1[i] + d2[i] > limit || !receives.has(label1[i])) continue;
    let free = true;
    for (const mask of masks) {
      if (mask[i] !== 0) {
        free = false;
        break;
      }
    }
    if (free) masks[label1[i]][i] = value1[i];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run `op` on the presence of each value, in its bounding box padded by `pad`,
 * and write the results into a copy of `mask`. A result only claims pixels
 * that were background or that value; with `grows`, it never takes another
 * value's pixels either, and an earlier value wins a contested pixel.
 */
function perValue(
  mask: Uint8Array,
  w: number,
  h: number,
  pad: number,
  op: (presence: Uint8Array, cw: number, ch: number) => Uint8Array,
  grows = false,
): Uint8Array {
  const boxes = valueBoxes(mask, w, h);
  const out = mask.slice();
  for (const [value, box] of boxes) {
    const x0 = Math.max(0, box.x0 - pad);
    const y0 = Math.max(0, box.y0 - pad);
    const x1 = Math.min(w - 1, box.x1 + pad);
    const y1 = Math.min(h - 1, box.y1 + pad);
    const crop = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const presence = new Uint8Array(crop.w * crop.h);
    for (let y = 0; y < crop.h; y++) {
      const row = (y0 + y) * w + x0;
      for (let x = 0; x < crop.w; x++) presence[y * crop.w + x] = mask[row + x] === value ? 1 : 0;
    }
    const result = op(presence, crop.w, crop.h);
    for (let y = 0; y < crop.h; y++) {
      const row = (y0 + y) * w + x0;
      for (let x = 0; x < crop.w; x++) {
        const i = row + x;
        const on = result[y * crop.w + x] !== 0;
        const original = mask[i];
        if (original === value) {
          if (!on) out[i] = 0;
        } else if (on && original === 0 && (!grows || out[i] === 0)) {
          out[i] = value;
        }
      }
    }
  }
  return out;
}

/** The 8-connected pieces of a presence mask, as pixel index lists. */
function components(p: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(p.length);
  const pieces: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < p.length; start++) {
    if (!p[start] || seen[start]) continue;
    const piece: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      piece.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (p[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    pieces.push(piece);
  }
  return pieces;
}

/** Bounding box of each nonzero value. */
function valueBoxes(
  mask: Uint8Array,
  w: number,
  h: number,
): Map<number, { x0: number; y0: number; x1: number; y1: number }> {
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const v = mask[row + x];
      if (v === 0) continue;
      const b = boxes.get(v);
      if (!b) boxes.set(v, { x0: x, y0: y, x1: x, y1: y });
      else {
        if (x < b.x0) b.x0 = x;
        if (x > b.x1) b.x1 = x;
        if (y > b.y1) b.y1 = y;
      }
    }
  }
  return boxes;
}

/** Squared Euclidean distance of every pixel to the nearest pixel equal to
 *  `target` (Felzenszwalb–Huttenlocher, exact, linear time). */
function distanceTo(p: Uint8Array, w: number, h: number, target: 0 | 1): Float64Array {
  const INF = 1e20;
  const d = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) d[i] = p[i] === target ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const out = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = d[y * w + x];
    edt1d(f, h, out, v, z);
    for (let y = 0; y < h; y++) d[y * w + x] = out[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = d[row + x];
    edt1d(f, w, out, v, z);
    for (let x = 0; x < w; x++) d[row + x] = out[x];
  }
  return d;
}

function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

function gaussianKernel(sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = value;
    sum += value;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** One pass of a separable convolution, along x or y, the edge value
 *  replicated past the ends. */
function convolve(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  kernel: Float32Array,
  alongX: boolean,
): void {
  const r = (kernel.length - 1) / 2;
  const len = alongX ? w : h;
  const lines = alongX ? h : w;
  const step = alongX ? 1 : w;
  for (let line = 0; line < lines; line++) {
    const base = alongX ? line * w : line;
    for (let i = 0; i < len; i++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const j = i + k < 0 ? 0 : i + k >= len ? len - 1 : i + k;
        acc += src[base + j * step] * kernel[k + r];
      }
      dst[base + i * step] = acc;
    }
  }
}
