import { pullString, resample, smoothPath } from './stroke-smoothing';
import { Point2D } from '../interface';

describe('stroke smoothing', () => {
  describe('pullString', () => {
    it('keeps the brush still while the pointer is within the radius', () => {
      const brush = { x: 10, y: 10 };
      expect(pullString(brush, { x: 13, y: 14 }, 5)).toBe(brush);
    });

    it('drags the brush to the radius when the string is taut', () => {
      const p = pullString({ x: 0, y: 0 }, { x: 10, y: 0 }, 4);
      expect(p.x).toBeCloseTo(6);
      expect(p.y).toBeCloseTo(0);
    });
  });

  describe('resample', () => {
    it('spaces samples evenly along an open path and keeps both ends', () => {
      const out = resample([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 10, y: 0 }], 2.5);
      expect(out.map((p) => p.x)).toEqual([0, 2.5, 5, 7.5, 10]);
    });

    it('covers the closing segment of a closed path', () => {
      const square = [
        { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 },
      ];
      const out = resample(square, 1, true);
      expect(out.length).toBe(16);
      expect(out[15]).toEqual({ x: 0, y: 1 });
    });
  });

  describe('smoothPath', () => {
    it('returns the input when the radius is 0', () => {
      const pts = [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }];
      expect(smoothPath(pts, 0, 1, true)).toBe(pts);
    });

    it('flattens jitter on a straight open line and keeps its ends', () => {
      const jittery: Point2D[] = [];
      for (let i = 0; i <= 100; i++) jittery.push({ x: i, y: i % 2 ? 1 : -1 });
      const out = smoothPath(jittery, 4, 1, false);
      const [first, last] = [out[0], out[out.length - 1]];
      expect(first.x).toBeCloseTo(0);
      expect(first.y).toBeCloseTo(-1);
      expect(last.x).toBeCloseTo(100);
      expect(last.y).toBeCloseTo(-1);
      const mid = out.slice(10, -10);
      for (const p of mid) expect(Math.abs(p.y)).toBeLessThan(0.3);
    });

    it('keeps a smoothed circle close to its radius', () => {
      const circle: Point2D[] = [];
      for (let i = 0; i < 360; i++) {
        const a = (i * Math.PI) / 180;
        const r = 50 + (i % 2 ? 1.5 : -1.5); // tremor
        circle.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
      }
      const out = smoothPath(circle, 5, 1, true);
      for (const p of out) expect(Math.abs(Math.hypot(p.x, p.y) - 50)).toBeLessThan(0.6);
    });
  });
});
