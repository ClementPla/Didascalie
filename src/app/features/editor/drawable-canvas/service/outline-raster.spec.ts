import {
  OutlineScratch,
  diagonalReach,
  paintLayerOutlined,
} from './outline-raster';

/** Palette: value v -> (v, 0, 0, 255). */
function palette(): Uint8Array {
  const pal = new Uint8Array(256 * 4);
  for (let v = 0; v < 256; v++) {
    pal[v * 4] = v;
    pal[v * 4 + 3] = 255;
  }
  return pal;
}

/** Brute force: interior when the octagon around the pixel holds its value. */
function isInteriorRef(src: Uint8Array, w: number, h: number, x: number, y: number, r: number) {
  const v = src[y * w + x];
  const s = diagonalReach(r);
  const at = (xx: number, yy: number) =>
    xx >= 0 && yy >= 0 && xx < w && yy < h ? src[yy * w + xx] : -1;
  for (let k = -r; k <= r; k++) {
    if (at(x + k, y) !== v || at(x, y + k) !== v) return false;
  }
  for (let dy = -s; dy <= s; dy++) {
    for (let dx = -s; dx <= s; dx++) if (at(x + dx, y + dy) !== v) return false;
  }
  return true;
}

describe('paintLayerOutlined', () => {
  const pal = palette();

  it('matches the brute-force octagon test', () => {
    const w = 40;
    const h = 31;
    // Blobs of two instances plus noise, deterministic.
    const src = new Uint8Array(w * h);
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d1 = Math.hypot(x - 12, y - 14);
        const d2 = Math.hypot(x - 27, y - 15);
        let v = d1 < 10 ? 1 : d2 < 9 ? 2 : 0;
        if (rand() < 0.03) v = 0; // pinholes
        src[y * w + x] = v;
      }
    }

    const scratch = new OutlineScratch();
    for (const r of [1, 2, 3, 5, 8]) {
      const data = new Uint8ClampedArray(w * h * 4);
      paintLayerOutlined(data, src, pal, w, h, { fillAlpha: 0, contourAlpha: 1, radius: r }, scratch);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          const expectEdge = src[i] !== 0 && !isInteriorRef(src, w, h, x, y, r);
          expect(data[i * 4 + 3])
            .withContext(`r=${r} at (${x}, ${y})`)
            .toBe(expectEdge ? 255 : 0);
        }
      }
    }
  });

  it('gives fill and contour their own opacity', () => {
    const w = 9;
    const src = new Uint8Array(w * w).fill(3);
    const data = new Uint8ClampedArray(w * w * 4);
    paintLayerOutlined(
      data, src, pal, w, w,
      { fillAlpha: 0.2, contourAlpha: 0.8, radius: 2 },
      new OutlineScratch()
    );
    expect(data[3]).toBe(204); // corner: contour
    expect(data[(4 * w + 4) * 4 + 3]).toBe(51); // centre: fill
    expect(data[(4 * w + 4) * 4]).toBe(3);
  });

  it('blends over what earlier layers painted', () => {
    const data = new Uint8ClampedArray([200, 0, 0, 255]);
    const src = new Uint8Array([100]);
    paintLayerOutlined(
      data, src, pal, 1, 1,
      { fillAlpha: 0, contourAlpha: 0.5, radius: 1 },
      new OutlineScratch()
    );
    expect(data[0]).toBeCloseTo(150, -1);
    expect(data[3]).toBe(255);
  });
});
