import { UndoRedoCanvasElement } from '../interface';

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

class UndoRedoStack {
  private undoStack = new Stack<UndoRedoCanvasElement>();
  private redoStack = new Stack<UndoRedoCanvasElement>();

  undo(): UndoRedoCanvasElement | undefined {
    // Need at least 2 states: current state and previous state
    if (this.undoStack.size() < 2) {
      return undefined; // or return current state if size === 1
    }

    // Pop current state and move to redo
    const currentState = this.undoStack.pop();
    if (currentState) {
      this.redoStack.push(currentState);
    }

    // Return the previous state (now current)
    return this.undoStack.peek();
  }

  redo(): UndoRedoCanvasElement | undefined {
    const element = this.redoStack.pop();
    if (element) {
      this.undoStack.push(element);
      return element;
    }
    return undefined;
  }

  push(element: UndoRedoCanvasElement): void {
    this.undoStack.push(element);
    this.redoStack.empty(); // Clear redo stack on new action
  }

  empty(): void {
    this.undoStack.empty();
    this.redoStack.empty();
  }

  canUndo(): boolean {
    return this.undoStack.size() > 1;
  }

  canRedo(): boolean {
    return !this.redoStack.isEmpty();
  }
}

export const UndoRedo = new UndoRedoStack();
