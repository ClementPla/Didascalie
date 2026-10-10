/**
 * Pixel operations on label masks.
 *
 * Each label is a `width*height` `Uint8Array`: 0 = absent, 1 = present
 * (semantic), 1..255 = instance id. Strokes are rasterized on a Canvas2D
 * buffer; callers pass the stroke's bounding-box region as RGBA (`region`)
 * with its integer `rect`, and a pixel is covered when its alpha reaches
 * `ALPHA_THRESHOLD`.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const ALPHA_THRESHOLD = 128;

/** Integer bbox clamped to the image, or null if it collapses to nothing. */
export function intRect(bbox: Rect, w: number, h: number): Rect | null {
  const x = Math.max(0, Math.floor(bbox.x));
  const y = Math.max(0, Math.floor(bbox.y));
  const x1 = Math.min(w, Math.ceil(bbox.x + bbox.width));
  const y1 = Math.min(h, Math.ceil(bbox.y + bbox.height));
  if (x1 <= x || y1 <= y) return null;
  return { x, y, width: x1 - x, height: y1 - y };
}

function forEachCovered(
  region: Uint8ClampedArray,
  rect: Rect,
  maskW: number,
  fn: (maskIdx: number) => void
): void {
  for (let ry = 0; ry < rect.height; ry++) {
    const maskRow = (rect.y + ry) * maskW + rect.x;
    const regRow = ry * rect.width;
    for (let rx = 0; rx < rect.width; rx++) {
      if (region[(regRow + rx) * 4 + 3] >= ALPHA_THRESHOLD) fn(maskRow + rx);
    }
  }
}

export function commitStroke(
  mask: Uint8Array,
  maskW: number,
  region: Uint8ClampedArray,
  rect: Rect,
  value: number
): void {
  forEachCovered(region, rect, maskW, (idx) => {
    mask[idx] = value;
  });
}

/**
 * Reassign already-labelled pixels under the stroke to the active label:
 * they become `value` in the active mask and are cleared from the others.
 * Background pixels are left alone.
 */
export function swapUnderStroke(
  masks: Uint8Array[],
  activeIndex: number,
  maskW: number,
  region: Uint8ClampedArray,
  rect: Rect,
  value: number
): void {
  forEachCovered(region, rect, maskW, (idx) => {
    let occupied = false;
    for (let m = 0; m < masks.length; m++) {
      if (masks[m][idx] !== 0) {
        occupied = true;
        break;
      }
    }
    if (!occupied) return;
    for (let m = 0; m < masks.length; m++) {
      masks[m][idx] = m === activeIndex ? value : 0;
    }
  });
}

export function eraseStrokeFromMasks(
  masks: Uint8Array[],
  maskW: number,
  region: Uint8ClampedArray,
  rect: Rect
): void {
  forEachCovered(region, rect, maskW, (idx) => {
    for (const mask of masks) mask[idx] = 0;
  });
}

/** Write `value` where a full-image result (`width*height`) is nonzero. */
export function applyResultMask(
  mask: Uint8Array,
  result: Uint8Array | Uint8ClampedArray,
  value: number
): void {
  const n = Math.min(mask.length, result.length);
  for (let i = 0; i < n; i++) {
    if (result[i] !== 0) mask[i] = value;
  }
}

/** Write `value` where a region result (`rect.width*rect.height`) is nonzero. */
export function applyRegionResult(
  mask: Uint8Array,
  maskW: number,
  result: Uint8Array | Uint8ClampedArray,
  rect: Rect,
  value: number
): void {
  for (let ry = 0; ry < rect.height; ry++) {
    const maskRow = (rect.y + ry) * maskW + rect.x;
    const resRow = ry * rect.width;
    for (let rx = 0; rx < rect.width; rx++) {
      if (result[resRow + rx] !== 0) mask[maskRow + rx] = value;
    }
  }
}

/** OR every mask's presence into a single 0/1 union buffer. */
export function unionPresence(masks: Uint8Array[], w: number, h: number): Uint8Array {
  const union = new Uint8Array(w * h);
  for (const mask of masks) {
    for (let i = 0; i < union.length; i++) {
      if (mask[i] !== 0) union[i] = 1;
    }
  }
  return union;
}

/**
 * The pixels of the 8-connected components of `presence` that the stroke
 * touches.
 */
export function componentsUnderStroke(
  presence: Uint8Array,
  maskW: number,
  maskH: number,
  region: Uint8ClampedArray,
  rect: Rect
): number[] {
  const visited = new Uint8Array(presence.length);
  const out: number[] = [];
  const stack: number[] = [];

  const flood = (start: number) => {
    stack.push(start);
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      out.push(idx);
      const px = idx % maskW;
      const py = (idx / maskW) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= maskW || ny >= maskH) continue;
          const ni = ny * maskW + nx;
          if (!visited[ni] && presence[ni] !== 0) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }
  };

  forEachCovered(region, rect, maskW, (idx) => {
    if (presence[idx] !== 0 && !visited[idx]) flood(idx);
  });
  return out;
}

/**
 * Zero the 8-connected component of `mask` sharing the value at (x, y).
 * Same-value flooding keeps touching instances separate. False if (x, y) is
 * out of range or background.
 */
export function clearValueComponentAt(
  mask: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number
): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const start = y * w + x;
  const value = mask[start];
  if (value === 0) return false;

  const stack = [start];
  const seen = new Uint8Array(mask.length);
  seen[start] = 1;
  let cleared = false;
  while (stack.length) {
    const idx = stack.pop()!;
    mask[idx] = 0;
    cleared = true;
    const px = idx % w;
    const py = (idx / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!seen[ni] && mask[ni] === value) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
  }
  return cleared;
}

/** Zero the connected component of `mask` containing pixel (x, y). */
export function clearComponentAt(
  mask: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number
): boolean {
  const start = y * w + x;
  if (x < 0 || y < 0 || x >= w || y >= h || mask[start] === 0) return false;

  const stack = [start];
  const seen = new Uint8Array(mask.length);
  seen[start] = 1;
  let cleared = false;
  while (stack.length) {
    const idx = stack.pop()!;
    mask[idx] = 0;
    cleared = true;
    const px = idx % w;
    const py = (idx / w) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!seen[ni] && mask[ni] !== 0) {
          seen[ni] = 1;
          stack.push(ni);
        }
      }
    }
  }
  return cleared;
}

/**
 * OR a mask's presence into a `step`-downsampled grid. Pass `out` to
 * accumulate several masks into one grid.
 */
export function downsamplePresence(
  mask: Uint8Array,
  w: number,
  h: number,
  step: number,
  out?: Uint8Array
): { grid: Uint8Array; dw: number; dh: number } {
  const dw = Math.ceil(w / step);
  const dh = Math.ceil(h / step);
  const grid = out ?? new Uint8Array(dw * dh);
  for (let y = 0; y < h; y++) {
    const drow = ((y / step) | 0) * dw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (mask[row + x] !== 0) grid[drow + ((x / step) | 0)] = 1;
    }
  }
  return { grid, dw, dh };
}

/**
 * Approximate bounding boxes of a large mask, from components found on a
 * `step`-downsampled grid. Accurate to ±`step` px.
 */
export function connectedComponentBoxesDownsampled(
  mask: Uint8Array,
  w: number,
  h: number,
  step: number
): Rect[] {
  if (step <= 1) return connectedComponentBoxes(mask, w, h);
  const { grid, dw, dh } = downsamplePresence(mask, w, h, step);
  const boxes = connectedComponentBoxes(grid, dw, dh);
  for (const b of boxes) {
    b.x *= step;
    b.y *= step;
    b.width *= step;
    b.height *= step;
  }
  return boxes;
}

/** Bounding boxes of the 8-connected components of `mask`. */
export function connectedComponentBoxes(mask: Uint8Array, w: number, h: number): Rect[] {
  const visited = new Uint8Array(mask.length);
  const boxes: Rect[] = [];
  const stack: number[] = [];

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 || visited[i]) continue;

    let minX = w, minY = h, maxX = 0, maxY = 0;
    stack.push(i);
    visited[i] = 1;
    while (stack.length) {
      const idx = stack.pop()!;
      const px = idx % w;
      const py = (idx / w) | 0;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const ni = ny * w + nx;
          if (!visited[ni] && mask[ni] !== 0) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }
    }
    boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
  }
  return boxes;
}
