import { VectorShape, cloneShapes } from './vector.model';

/**
 * Undo/redo history of the vector editor: a stack of snapshots of the shapes
 * array. Index 0 is the loaded state, which undo never goes past. Snapshots
 * are cloned on the way in.
 */
export class VectorHistory {
  private undoStack: VectorShape[][] = [[]];
  private redoStack: VectorShape[][] = [];

  reset(shapes: VectorShape[]): void {
    this.undoStack = [cloneShapes(shapes)];
    this.redoStack = [];
  }

  /** Record a committed state, discarding any redo branch. */
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

  /** The snapshot to restore, or null at the baseline. */
  stepBack(): VectorShape[] | null {
    if (this.undoStack.length <= 1) return null;
    const current = this.undoStack.pop()!;
    this.redoStack.push(current);
    return this.undoStack[this.undoStack.length - 1];
  }

  /** The snapshot to restore, or null when there is nothing to redo. */
  stepForward(): VectorShape[] | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(next);
    return next;
  }
}
