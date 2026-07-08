import { VectorShape, cloneShapes } from './vector.model';

/**
 * Undo/redo history for the vector editor: a stack of full shape-array
 * snapshots. Index 0 is the baseline (the loaded state); undo never pops past
 * it. Snapshots are cloned on the way *in* so later edits can't mutate history;
 * `stepBack`/`stepForward` return the stored snapshot to restore (the caller
 * applies it into its own reactive state).
 *
 * Extracted from VectorEditorService so the history mechanics are isolated and
 * unit-testable, independent of Angular signals.
 */
export class VectorHistory {
  private undoStack: VectorShape[][] = [[]];
  private redoStack: VectorShape[][] = [];

  /** Reset to a single baseline snapshot (on frame load, or `[]` on clear). */
  reset(shapes: VectorShape[]): void {
    this.undoStack = [cloneShapes(shapes)];
    this.redoStack = [];
  }

  /** Record a newly committed state, discarding any redo branch. */
  commit(shapes: VectorShape[]): void {
    this.undoStack.push(cloneShapes(shapes));
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 1;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Step back one committed change; returns the snapshot to restore, or null
   *  when already at the baseline. */
  stepBack(): VectorShape[] | null {
    if (this.undoStack.length <= 1) return null;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    return this.undoStack[this.undoStack.length - 1];
  }

  /** Re-apply the most recently undone change; returns the snapshot to restore,
   *  or null when there is nothing to redo. */
  stepForward(): VectorShape[] | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(next);
    return next;
  }
}
