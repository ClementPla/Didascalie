import {
  clearComponentAt,
  clearValueComponentAt,
  componentsUnderStroke,
  connectedComponentBoxes,
  swapUnderStroke,
} from './label-ops';

/** A mask from rows of digits; '.' is 0. */
function maskFrom(rows: string[]): { mask: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const mask = new Uint8Array(w * h);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => (mask[y * w + x] = c === '.' ? 0 : Number(c))),
  );
  return { mask, w, h };
}

function rowsOf(mask: Uint8Array, w: number): string[] {
  const rows: string[] = [];
  for (let i = 0; i < mask.length; i += w) {
    rows.push([...mask.subarray(i, i + w)].map((v) => (v ? String(v) : '.')).join(''));
  }
  return rows;
}

describe('label-ops connected components', () => {
  // Two blobs; the right one touches the left only diagonally at (2,1)-(3,2).
  const rows = [
    '11.....',
    '.11....',
    '...2...',
    '...22..',
    '......1',
  ];

  it('clearComponentAt clears the 8-connected region of any non-zero value', () => {
    const { mask, w, h } = maskFrom(rows);
    expect(clearComponentAt(mask, w, h, 0, 0)).toBeTrue();
    expect(rowsOf(mask, w)).toEqual([
      '.......',
      '.......',
      '.......',
      '.......',
      '......1',
    ]);
  });

  it('clearValueComponentAt keeps touching instances of another value', () => {
    const { mask, w, h } = maskFrom(rows);
    expect(clearValueComponentAt(mask, w, h, 0, 0)).toBeTrue();
    expect(rowsOf(mask, w)).toEqual([
      '.......',
      '.......',
      '...2...',
      '...22..',
      '......1',
    ]);
  });

  it('clear functions refuse background and out-of-range pixels', () => {
    const { mask, w, h } = maskFrom(rows);
    expect(clearComponentAt(mask, w, h, 6, 0)).toBeFalse();
    expect(clearValueComponentAt(mask, w, h, -1, 0)).toBeFalse();
    expect(clearComponentAt(mask, w, h, w, 0)).toBeFalse();
    expect(rowsOf(mask, w)).toEqual(rows);
  });

  it('connectedComponentBoxes boxes each 8-connected component', () => {
    const { mask, w, h } = maskFrom(rows);
    const boxes = connectedComponentBoxes(mask, w, h);
    expect(boxes).toEqual([
      { x: 0, y: 0, width: 5, height: 4 },
      { x: 6, y: 4, width: 1, height: 1 },
    ]);
  });

  it('componentsUnderStroke returns every pixel of the components a stroke covers', () => {
    const { mask, w, h } = maskFrom(rows);
    // A 1x1 stroke over (6,4), as an RGBA region with full alpha.
    const region = new Uint8ClampedArray([0, 0, 0, 255]);
    const hit = componentsUnderStroke(mask, w, h, region, { x: 6, y: 4, width: 1, height: 1 });
    expect(hit).toEqual([4 * w + 6]);

    // Over (0,0): the whole diagonal-joined blob.
    const all = componentsUnderStroke(mask, w, h, region, { x: 0, y: 0, width: 1, height: 1 });
    expect(all.sort((a, b) => a - b)).toEqual([0, 1, 8, 9, 17, 24, 25]);
  });
});

describe('swapUnderStroke', () => {
  // A 4x1 strip; the stroke covers the middle two pixels.
  const rect = { x: 1, y: 0, width: 2, height: 1 };
  const region = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]);
  const masks = () => [
    Uint8Array.from([1, 1, 0, 0]), // active
    Uint8Array.from([0, 0, 1, 0]), // target
    Uint8Array.from([0, 1, 1, 0]), // not a target
  ];

  it('swap: takes over only what the targets hold', () => {
    const m = masks();
    swapUnderStroke(m, 0, 4, region, rect, 1, [true, true, false]);
    expect([...m[0]]).toEqual([1, 1, 1, 0]);
    expect([...m[1]]).toEqual([0, 0, 0, 0]);
    expect([...m[2]]).toEqual([0, 1, 1, 0]); // untouched
  });

  it('swap and draw: also paints the rest of the stroke', () => {
    const m = masks();
    m[1][2] = 0; // nothing under the stroke for the targets
    swapUnderStroke(m, 0, 4, region, rect, 1, [true, true, false], true);
    expect([...m[0]]).toEqual([1, 1, 1, 0]);
    expect([...m[2]]).toEqual([0, 1, 1, 0]);
  });

  it('with no target list, every label takes part', () => {
    const m = masks();
    swapUnderStroke(m, 0, 4, region, rect, 1);
    expect([...m[0]]).toEqual([1, 1, 1, 0]);
    expect([...m[2]]).toEqual([0, 0, 0, 0]);
  });
});
