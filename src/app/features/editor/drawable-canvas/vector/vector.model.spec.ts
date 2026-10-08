import {
  VectorShape,
  ellipseNodes,
  flattenShape,
  rectNodes,
  rotateShape,
  shapeBounds,
  shapesBounds,
  sideHandles,
  stretchShape,
} from './vector.model';

function closed(nodes: VectorShape['nodes']): VectorShape {
  return { id: 's', labelId: 1, closed: true, filled: false, nodes };
}

describe('vector.model shapes', () => {
  it('builds a rectangle from any two opposite corners', () => {
    const b = shapeBounds(closed(rectNodes({ x: 30, y: 5 }, { x: 10, y: 25 })));
    expect(b).toEqual({ x: 10, y: 5, width: 20, height: 20 });
  });

  it('builds an ellipse that stays on its radii', () => {
    const shape = closed(ellipseNodes({ x: 0, y: 0 }, { x: 40, y: 20 }));
    for (const p of flattenShape(shape)) {
      const r = ((p.x - 20) / 20) ** 2 + ((p.y - 10) / 10) ** 2;
      expect(r).toBeCloseTo(1, 2);
    }
  });

  it('rotates anchors and handles around the pivot', () => {
    const shape = closed(ellipseNodes({ x: 0, y: 0 }, { x: 40, y: 20 }));
    const turned = rotateShape(shape, { x: 20, y: 10 }, Math.PI / 2);
    const b = shapeBounds(turned)!;
    expect(b.x).toBeCloseTo(10, 1);
    expect(b.y).toBeCloseTo(-10, 1);
    expect(b.width).toBeCloseTo(20, 1);
    expect(b.height).toBeCloseTo(40, 1);

    const back = rotateShape(turned, { x: 20, y: 10 }, -Math.PI / 2);
    back.nodes.forEach((n, i) => {
      expect(n.x).toBeCloseTo(shape.nodes[i].x, 6);
      expect(n.outY).toBeCloseTo(shape.nodes[i].outY, 6);
    });
  });

  it('resizes a rotated box along a side normal and keeps it a box', () => {
    const pivot = { x: 20, y: 10 };
    const box = rotateShape(
      closed(rectNodes({ x: 0, y: 0 }, { x: 40, y: 20 })),
      pivot,
      Math.PI / 6,
    );
    const h = sideHandles(box)[1]; // the 20-long side; its normal spans 40
    const extent = Math.hypot(h.pos.x - h.anchor.x, h.pos.y - h.anchor.y);
    expect(extent).toBeCloseTo(40, 6);
    const u = {
      x: (h.pos.x - h.anchor.x) / extent,
      y: (h.pos.y - h.anchor.y) / extent,
    };
    const back = rotateShape(stretchShape(box, h.anchor, u, 1.5), pivot, -Math.PI / 6);
    const b = shapeBounds(back)!;
    expect(b.x).toBeCloseTo(0, 6);
    expect(b.y).toBeCloseTo(0, 6);
    expect(b.width).toBeCloseTo(60, 6);
    expect(b.height).toBeCloseTo(20, 6);
  });

  it('offers side grips only on boxes and ellipses', () => {
    expect(sideHandles(closed(ellipseNodes({ x: 0, y: 0 }, { x: 4, y: 2 }))).length).toBe(4);
    const tri = closed(rectNodes({ x: 0, y: 0 }, { x: 4, y: 2 }).slice(0, 3));
    expect(sideHandles(tri)).toEqual([]);
  });

  it('unions bounds across shapes', () => {
    const a = closed(rectNodes({ x: 0, y: 0 }, { x: 10, y: 10 }));
    const b = closed(rectNodes({ x: 20, y: 5 }, { x: 30, y: 40 }));
    expect(shapesBounds([a, b])).toEqual({ x: 0, y: 0, width: 30, height: 40 });
    expect(shapesBounds([])).toBeNull();
  });
});
