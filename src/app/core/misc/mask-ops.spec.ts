import {
  dilate,
  erode,
  fillGaps,
  fillHoles,
  invertInUnlabelled,
  invertWhole,
  keepLargest,
  removeIslands,
  smooth,
  subtractFromOthers,
  takeAddedFromOthers,
} from './mask-ops';

/** A `w×h` mask from rows of characters: '.' is 0, a digit is that value. */
function grid(rows: string[]): { mask: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const mask = new Uint8Array(w * h);
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => (mask[y * w + x] = c === '.' ? 0 : Number(c))),
  );
  return { mask, w, h };
}

function rows(mask: Uint8Array, w: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < mask.length / w; y++) {
    out.push([...mask.subarray(y * w, (y + 1) * w)].map((v) => (v ? String(v) : '.')).join(''));
  }
  return out;
}

const count = (m: Uint8Array) => m.reduce((n, v) => n + (v ? 1 : 0), 0);

describe('mask-ops', () => {
  it('inverts over the whole image', () => {
    const { mask } = grid(['1.', '.1']);
    invertWhole(mask, 1);
    expect([...mask]).toEqual([0, 1, 1, 0]);
  });

  it('inverts into unlabelled pixels only', () => {
    const a = grid(['1...']).mask;
    const b = grid(['.1..']).mask;
    invertInUnlabelled([a, b], 0, 1);
    expect([...a]).toEqual([0, 0, 1, 1]);
    expect([...b]).toEqual([0, 1, 0, 0]);
  });

  it('subtracts a label from the others', () => {
    const a = grid(['11..']).mask;
    const b = grid(['.11.']).mask;
    subtractFromOthers([a, b], 0);
    expect([...b]).toEqual([0, 0, 1, 0]);
    expect([...a]).toEqual([1, 1, 0, 0]);
  });

  it('takes the gained pixels from the labels that had them', () => {
    const before = grid(['1...']).mask;
    const grown = grid(['11..']).mask;
    const other = grid(['.11.']).mask;
    const otherBefore = other.slice();
    takeAddedFromOthers(before, [grown, other], [before, otherBefore], 0);
    expect([...other]).toEqual([0, 0, 1, 0]);
    expect([...grown]).toEqual([1, 1, 0, 0]);
  });

  it('dilates and erodes by a Euclidean radius', () => {
    const { mask, w, h } = grid(['.....', '.....', '..1..', '.....', '.....']);
    const grown = dilate(mask, w, h, 1);
    expect(rows(grown, w)).toEqual(['.....', '..1..', '.111.', '..1..', '.....']);
    expect(rows(erode(grown, w, h, 1), w)).toEqual(['.....', '.....', '..1..', '.....', '.....']);
  });

  it('does not erode from the image edge', () => {
    const { mask, w, h } = grid(['111', '111', '...']);
    expect(rows(erode(mask, w, h, 1), w)).toEqual(['111', '...', '...']);
  });

  it('keeps instances apart when dilating', () => {
    const { mask, w, h } = grid(['1...2']);
    expect(rows(dilate(mask, w, h, 2), w)).toEqual(['11122']);
  });

  it('fills holes up to an area, not what reaches the edge', () => {
    const { mask, w, h } = grid([
      '1111111.',
      '1.11..1.',
      '1111..1.',
      '1111111.',
    ]);
    expect(rows(fillHoles(mask, w, h, 1), w)).toEqual([
      '1111111.',
      '1111..1.',
      '1111..1.',
      '1111111.',
    ]);
    expect(count(fillHoles(mask, w, h, Infinity))).toBe(28);
  });

  it('smooths away a one-pixel spur and keeps a block', () => {
    const { mask, w, h } = grid([
      '..........',
      '..........',
      '..11111...',
      '..11111...',
      '..111111..',
      '..11111...',
      '..11111...',
      '..........',
    ]);
    const out = smooth(mask, w, h, 1);
    expect(out[4 * w + 7]).toBe(0);
    expect(out[4 * w + 4]).toBe(1);
  });

  it('removes small islands and keeps the largest piece', () => {
    const { mask, w, h } = grid(['11..1', '11...', '.....', '...11']);
    expect(rows(removeIslands(mask, w, h, 2), w)).toEqual(['11...', '11...', '.....', '.....']);
    expect(rows(keepLargest(mask, w, h), w)).toEqual(['11...', '11...', '.....', '.....']);
  });

  it('fills a gap between two labels, split at the midline', () => {
    const a = grid(['11....', '11....', '11....']).mask;
    const b = grid(['....11', '....11', '....11']).mask;
    fillGaps([a, b], 6, 3, 2, [0, 1], false);
    expect(rows(a, 6)).toEqual(['111...', '111...', '111...']);
    expect(rows(b, 6)).toEqual(['...111', '...111', '...111']);
  });

  it('leaves outer edges and wide gaps alone', () => {
    const a = grid(['1.....', '1.....']).mask;
    const b = grid(['.....1', '.....1']).mask;
    fillGaps([a, b], 6, 2, 2, [0, 1], false);
    expect(rows(a, 6)).toEqual(['1.....', '1.....']);
    const lone = grid(['......', '..1...', '......']).mask;
    fillGaps([lone], 6, 3, 3, [0], false);
    expect(count(lone)).toBe(1);
  });

  it('fills only the side of the target label', () => {
    const a = grid(['1..2']).mask;
    const b = grid(['....']).mask;
    fillGaps([a, b], 4, 1, 2, [0], false);
    expect(rows(a, 4)).toEqual(['1..2']); // one label: no gap between labels
    fillGaps([a, b], 4, 1, 2, [0], true);
    expect(rows(a, 4)).toEqual(['1122']); // instances apart
  });
});
