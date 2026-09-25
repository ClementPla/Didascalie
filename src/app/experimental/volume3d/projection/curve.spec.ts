import {
  closestSpan,
  controlPointsFor,
  longestSkeletonPath,
  resampleByArcLength,
  splineBeziers,
  splineLength,
  Point,
} from './curve';

/** A straight horizontal run, where every arc length is known exactly. */
const straight: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 20, y: 0 },
];

describe('curve geometry', () => {
  describe('splineBeziers', () => {
    it('emits one span per gap between control points', () => {
      expect(splineBeziers(straight).length).toBe(2);
    });

    it('emits nothing for fewer than two points', () => {
      expect(splineBeziers([{ x: 1, y: 1 }]).length).toBe(0);
      expect(splineBeziers([]).length).toBe(0);
    });

    it('anchors each span on its own control points', () => {
      const [first] = splineBeziers(straight);
      expect(first[0]).toEqual(straight[0]);
      expect(first[3]).toEqual(straight[1]);
    });
  });

  describe('splineLength', () => {
    it('measures a straight run as its geometric length', () => {
      // Collinear points cannot overshoot, so the spline is the polyline.
      expect(splineLength(straight)).toBeCloseTo(20, 1);
    });

    it('is zero for a degenerate curve', () => {
      expect(splineLength([{ x: 5, y: 5 }])).toBe(0);
      expect(splineLength([])).toBe(0);
    });
  });

  describe('resampleByArcLength', () => {
    it('returns exactly the requested number of points', () => {
      expect(resampleByArcLength(straight, 7).length).toBe(7);
    });

    it('pins the first and last samples to the curve ends', () => {
      const out = resampleByArcLength(straight, 5);
      expect(out[0].x).toBeCloseTo(0, 3);
      expect(out[out.length - 1].x).toBeCloseTo(20, 3);
    });

    it('spaces samples evenly by arc length, not by control point', () => {
      // The gaps are equal even though the input points are unevenly spaced.
      const uneven: Point[] = [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 20, y: 0 },
      ];
      const out = resampleByArcLength(uneven, 5);
      const gaps = out.slice(1).map((p, i) => p.x - out[i].x);
      for (const gap of gaps) expect(gap).toBeCloseTo(gaps[0], 1);
    });

    it('refuses counts below two, and degenerate curves', () => {
      expect(resampleByArcLength(straight, 1)).toEqual([]);
      expect(resampleByArcLength([{ x: 0, y: 0 }], 5)).toEqual([]);
    });
  });

  describe('closestSpan', () => {
    it('picks the span nearest the probe', () => {
      // Near the far end of a two-span curve, so the second span must win.
      expect(closestSpan(straight, { x: 19, y: 1 })!.index).toBe(1);
      expect(closestSpan(straight, { x: 1, y: 1 })!.index).toBe(0);
    });

    it('reports the distance to the curve, not to a control point', () => {
      const hit = closestSpan(straight, { x: 10, y: 3 })!;
      expect(hit.distance).toBeCloseTo(3, 1);
    });

    it('is null when there is no span to hit', () => {
      expect(closestSpan([{ x: 0, y: 0 }], { x: 0, y: 0 })).toBeNull();
    });
  });

  describe('controlPointsFor', () => {
    it('passes through short polylines untouched', () => {
      const two: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
      expect(controlPointsFor(two)).toEqual(two);
    });

    it('simplifies until it fits the budget', () => {
      // A dense arc: far more input points than the cap allows.
      const arc: Point[] = Array.from({ length: 200 }, (_, i) => ({
        x: i,
        y: Math.sin(i / 12) * 40,
      }));
      const out = controlPointsFor(arc, 12);
      expect(out.length).toBeLessThanOrEqual(12);
      expect(out.length).toBeGreaterThan(2);
    });

    it('keeps the polyline endpoints', () => {
      const arc: Point[] = Array.from({ length: 60 }, (_, i) => ({ x: i, y: (i % 7) * 3 }));
      const out = controlPointsFor(arc, 8);
      expect(out[0]).toEqual(arc[0]);
      expect(out[out.length - 1]).toEqual(arc[arc.length - 1]);
    });
  });

  describe('longestSkeletonPath', () => {
    it('explores only the component holding the first branch', () => {
      // Documents a real limitation rather than an intent: the double sweep
      // starts at the first branch's node, so disconnected branches are never
      // reached and a longer one elsewhere is ignored. Fine for skeletons of a
      // single connected region, which is all the caller produces today —
      // but wrong if it is ever handed several regions at once.
      const first: Point[] = [{ x: 0, y: 0 }, { x: 3, y: 0 }];
      const longerElsewhere: Point[] = [{ x: 0, y: 50 }, { x: 40, y: 50 }];
      const out = longestSkeletonPath([first, longerElsewhere]);
      expect(out.map((p) => p.y)).toEqual([0, 0]);
      expect(out.length).toBe(2);
    });

    it('is empty when there are no branches', () => {
      expect(longestSkeletonPath([])).toEqual([]);
    });

    it('joins branches whose ends are within the snap distance', () => {
      // Two collinear halves meeting at (10,0) within snap, so the result
      // spans both rather than picking one.
      const a: Point[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
      const b: Point[] = [{ x: 11, y: 0 }, { x: 25, y: 0 }];
      const joined = longestSkeletonPath([a, b], 2);
      expect(joined.length).toBeGreaterThan(2);
      const xs = joined.map((p) => p.x);
      expect(Math.min(...xs)).toBeCloseTo(0, 3);
      expect(Math.max(...xs)).toBeCloseTo(25, 3);
    });
  });
});
