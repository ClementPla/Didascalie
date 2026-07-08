import { VectorHistory } from './vector-history';
import { VectorShape, makeNode } from './vector.model';

function shape(id: string): VectorShape {
  return {
    id,
    labelId: 1,
    closed: false,
    filled: false,
    nodes: [makeNode(0, 0), makeNode(10, 10)],
  };
}

function ids(shapes: VectorShape[] | null): string[] {
  return (shapes ?? []).map((s) => s.id);
}

describe('VectorHistory', () => {
  let history: VectorHistory;

  beforeEach(() => {
    history = new VectorHistory();
  });

  it('starts empty with nothing to undo or redo', () => {
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
    expect(history.stepBack()).toBeNull();
    expect(history.stepForward()).toBeNull();
  });

  it('undoes back to the reset baseline but no further', () => {
    history.reset([shape('a')]);
    history.commit([shape('a'), shape('b')]);

    expect(history.canUndo()).toBe(true);
    expect(ids(history.stepBack())).toEqual(['a']); // back to baseline
    expect(history.canUndo()).toBe(false);
    expect(history.stepBack()).toBeNull(); // never past baseline
  });

  it('redoes a change that was undone', () => {
    history.reset([]);
    history.commit([shape('a')]);

    expect(ids(history.stepBack())).toEqual([]); // undo
    expect(history.canRedo()).toBe(true);
    expect(ids(history.stepForward())).toEqual(['a']); // redo
    expect(history.canRedo()).toBe(false);
  });

  it('clears the redo branch when a new change is committed', () => {
    history.reset([]);
    history.commit([shape('a')]);
    history.stepBack(); // now redo has one entry

    history.commit([shape('b')]); // a fresh action
    expect(history.canRedo()).toBe(false);
  });

  it('snapshots are isolated from later mutation of the source array', () => {
    const shapes = [shape('a')];
    history.reset([]);
    history.commit(shapes);
    shapes.push(shape('b')); // mutate the array we committed

    expect(ids(history.stepBack())).toEqual([]);
    expect(ids(history.stepForward())).toEqual(['a']); // still just 'a'
  });
});
