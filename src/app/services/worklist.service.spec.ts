import { WorklistEntry, WorklistService } from './worklist.service';

/** Entries named after their id, with no frames, progress or answers. */
function entries(ids: number[]): WorklistEntry[] {
  return ids.map((id) => ({
    id,
    title: `seq ${id}`,
    frameCount: 0,
    progress: 0,
    classes: {},
    regressions: {},
  }));
}

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
    worklist.set(entries([7, 3, 12]), 'Not started');
    expect(worklist.neighbour(7, 1)).toBe(3);
    expect(worklist.neighbour(3, 1)).toBe(12);
    expect(worklist.neighbour(3, -1)).toBe(7);
    expect(worklist.indexOf(12)).toBe(2);
  });

  it('stops at either end', () => {
    worklist.set(entries([7, 3, 12]), '');
    expect(worklist.neighbour(12, 1)).toBeNull();
    expect(worklist.neighbour(7, -1)).toBeNull();
  });

  it('gives nothing for a sequence off the list', () => {
    worklist.set(entries([7, 3]), '');
    expect(worklist.indexOf(5)).toBe(-1);
    expect(worklist.neighbour(5, 1)).toBeNull();
  });

  it('keeps its own copy of the ids', () => {
    const list = entries([1, 2]);
    worklist.set(list, '');
    list.push(...entries([3]));
    expect(worklist.size()).toBe(2);
  });

  it('is cleared with the project', () => {
    worklist.set(entries([1, 2]), 'Reviewed');
    worklist.resetForProject();
    expect(worklist.ids()).toBeNull();
    expect(worklist.description()).toBe('');
  });

  it('sorts by each level in turn, unanswered last', () => {
    const list = entries([1, 2, 3, 4]);
    list[0].frameCount = 2;
    list[1].frameCount = 1;
    list[2].frameCount = 2;
    list[3].frameCount = 1;
    list[0].regressions = { size: 0.5 };
    list[2].regressions = { size: 0.9 };
    list[3].regressions = { size: 0.1 };
    worklist.set(list, '');
    worklist.setTaskFields([
      { id: 'value:size', label: 'size', value: (e) => e.regressions['size'] },
    ]);
    worklist.cycleSort('frames');
    worklist.cycleSort('value:size');
    worklist.cycleSort('value:size');
    expect(worklist.ids()).toEqual([4, 2, 3, 1]);
    expect(worklist.description()).toBe('Frames ↑ · size ↓');
    // Frames: ascending -> descending -> off.
    worklist.cycleSort('frames');
    worklist.cycleSort('frames');
    expect(worklist.ids()).toEqual([3, 1, 4, 2]);
    worklist.cycleSort('value:size');
    worklist.cycleSort('value:size');
    expect(worklist.ids()).toEqual([4, 1, 3, 2]);
  });

  it('drops the levels on tasks the project no longer has', () => {
    worklist.setTaskFields([{ id: 'value:a', label: 'a', value: () => 0 }]);
    worklist.cycleSort('value:a');
    worklist.cycleSort('name');
    worklist.resetForProject();
    expect(worklist.sortKeys()).toEqual([{ field: 'name', descending: false }]);
  });
});
