import {
  buildSurface,
  forEachColumnVoxel,
  rowToSlice,
  sampleSurface,
  sliceToRow,
} from './projection-surface';

/** Four vertical segments, x = 1..4, from y = 0 to y = 8, in a 6×9×3 volume. */
function vertical(zSpacing = 1, t = 0.5) {
  const columns = 4;
  const ends = new Float32Array(columns * 4);
  for (let c = 0; c < columns; c++) ends.set([c + 1.5, 0.5, c + 1.5, 8.5], c * 4);
  return buildSurface(ends, columns, 6, 9, 3, zSpacing, t);
}

describe('projection surface', () => {
  it('has one row per slice at unit spacing', () => {
    const s = vertical();
    expect(s.rows).toBe(3);
    expect([0, 1, 2].map((r) => rowToSlice(r, s))).toEqual([0, 1, 2]);
    expect([0, 1, 2].map((z) => sliceToRow(z, s))).toEqual([0, 1, 2]);
  });

  it('gives each slice zSpacing rows and writes from the middle one', () => {
    const s = vertical(3);
    expect(s.rows).toBe(9);
    expect(rowToSlice(2, s)).toBe(0);
    expect(rowToSlice(3, s)).toBe(1);
    expect(rowToSlice(8, s)).toBe(2);
    expect([0, 1, 2].map((z) => sliceToRow(z, s))).toEqual([1, 4, 7]);
  });

  it('maps every slice to a row when slices are closer than pixels', () => {
    const s = vertical(0.4);
    expect(s.rows).toBe(1);
    expect([0, 1, 2].map((z) => sliceToRow(z, s))).toEqual([0, 0, 0]);
  });

  it('places each column at depth t of its segment', () => {
    const s = vertical(1, 0.25);
    // y = 0.5 + 8 * 0.25 = 2.5, so row 2 of the image; column 0 is x = 1.
    expect(Array.from(s.locals)).toEqual([2 * 6 + 1, 2 * 6 + 2, 2 * 6 + 3, 2 * 6 + 4]);
  });

  it('marks a column outside the image', () => {
    const ends = new Float32Array([-5, 2, -3, 2]);
    expect(buildSurface(ends, 1, 6, 9, 3, 1, 0.5).locals[0]).toBe(-1);
  });

  it('samples the voxel under each surface pixel', () => {
    const s = vertical();
    const volume = new Uint8Array(6 * 9 * 3);
    volume[1 * 54 + 4 * 6 + 2] = 7; // slice 1, y = 4, x = 2: column 1
    const out = new Uint8Array(s.columns * s.rows);
    sampleSurface(volume, s, out);
    expect(Array.from(out)).toEqual([0, 0, 0, 0, 0, 7, 0, 0, 0, 0, 0, 0]);
  });

  it('writes a column back along its segment, radius on each side', () => {
    const s = vertical();
    const hit = new Set<number>();
    forEachColumnVoxel(s, 0, 2, (local) => hit.add(local));
    // x = 1, y from 4.5 - 2 to 4.5 + 2.
    expect([...hit].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6].map((y) => y * 6 + 1));
  });

  it('round-trips: what is written at the surface is read back there', () => {
    const s = vertical();
    const volume = new Uint8Array(6 * 9 * 3);
    forEachColumnVoxel(s, 2, 0.5, (local) => (volume[2 * 54 + local] = 3));
    const out = new Uint8Array(s.columns * s.rows);
    sampleSurface(volume, s, out);
    expect(out[sliceToRow(2, s) * s.columns + 2]).toBe(3);
    expect(out.filter((v) => v !== 0).length).toBe(1);
  });
});
