class Stack<T> {
  private stack: T[] = [];

  isEmpty(): boolean {
    return this.stack.length === 0;
  }

  push(element: T): void {
    this.stack.push(element);
  }

  pop(): T | undefined {
    return this.stack.pop();
  }

  peek(): T | undefined {
    return this.stack[this.stack.length - 1];
  }

  empty(): void {
    this.stack = [];
  }

  size(): number {
    return this.stack.length;
  }
}

export class UndoRedo<T> {
  private undoStack = new Stack<T>();
  private redoStack = new Stack<T>();

  undo(): T | undefined {
    // The current state and the one before it.
    if (this.undoStack.size() < 2) {
      return undefined;
    }

    const currentState = this.undoStack.pop();
    if (currentState) {
      this.redoStack.push(currentState);
    }

    return this.undoStack.peek();
  }

  redo(): T | undefined {
    const element = this.redoStack.pop();
    if (element) {
      this.undoStack.push(element);
      return element;
    }
    return undefined;
  }

  push(element: T): void {
    this.undoStack.push(element);
    this.redoStack.empty(); // Clear redo stack on new action
  }

  empty(): void {
    this.undoStack.empty();
    this.redoStack.empty();
  }

  /**
   * Replace the current state without recording an action, for a change made
   * outside this history.
   */
  replaceCurrent(element: T): void {
    this.undoStack.pop();
    this.undoStack.push(element);
  }

  canUndo(): boolean {
    return this.undoStack.size() > 1;
  }

  canRedo(): boolean {
    return !this.redoStack.isEmpty();
  }

  size(): number {
    return this.undoStack.size();
  }

  peek(): T | undefined {
    return this.undoStack.peek();
  }

  isEmpty(): boolean {
    return this.undoStack.isEmpty();
  }

}
