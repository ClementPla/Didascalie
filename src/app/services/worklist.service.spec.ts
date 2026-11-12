import { WorklistService } from './worklist.service';

describe('WorklistService', () => {
  let worklist: WorklistService;

  beforeEach(() => {
    worklist = new WorklistService();
  });

  it('has no list until the gallery sets one', () => {
    expect(worklist.ids()).toBeNull();
    expect(worklist.neighbour(1, 1)).toBeNull();
  });

  it('steps through the listed order, not the ids', () => {
    worklist.set([7, 3, 12], 'Not started');
    expect(worklist.neighbour(7, 1)).toBe(3);
    expect(worklist.neighbour(3, 1)).toBe(12);
    expect(worklist.neighbour(3, -1)).toBe(7);
    expect(worklist.indexOf(12)).toBe(2);
  });

  it('stops at either end', () => {
    worklist.set([7, 3, 12], '');
    expect(worklist.neighbour(12, 1)).toBeNull();
    expect(worklist.neighbour(7, -1)).toBeNull();
  });

  it('gives nothing for a sequence off the list', () => {
    worklist.set([7, 3], '');
    expect(worklist.indexOf(5)).toBe(-1);
    expect(worklist.neighbour(5, 1)).toBeNull();
  });

  it('keeps its own copy of the ids', () => {
    const ids = [1, 2];
    worklist.set(ids, '');
    ids.push(3);
    expect(worklist.size()).toBe(2);
  });

  it('is cleared with the project', () => {
    worklist.set([1, 2], 'Reviewed');
    worklist.resetForProject();
    expect(worklist.ids()).toBeNull();
    expect(worklist.description()).toBe('');
  });
});
