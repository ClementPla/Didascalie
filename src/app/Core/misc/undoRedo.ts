import { UndoRedoCanvasElement } from '../interface';

export class _UndoStack {
  stack: UndoRedoCanvasElement[] = [];

  isEmpty(): boolean {
    return this.stack.length === 0;
  }

  push(element: UndoRedoCanvasElement) {
    this.stack.push(element);
  }

  pop(): UndoRedoCanvasElement | undefined {
    return this.stack.pop();
  }

  empty() {
    this.stack = [];
  }
}

export class _RedoStack {
  stack: UndoRedoCanvasElement[] = [];

  isEmpty(): boolean {
    return this.stack.length === 0;
  }

  push(element: UndoRedoCanvasElement) {
    this.stack.push(element);
  }

  pop(): UndoRedoCanvasElement | undefined {
    return this.stack.pop();
  }

  empty() {
    this.stack = [];
  }
}

class UndoRedoStack {
  undoStack: _UndoStack = new _UndoStack();
  redoStack: _RedoStack = new _RedoStack();

  undo() {
    const element = this.undoStack.pop();
    if (element) {
      this.redoStack.push(element);
    }
    return element;
  }

  redo() {
    const element = this.redoStack.pop();
    if (element) {
      this.undoStack.push(element);
    }
    return element;
  }

  push(element: UndoRedoCanvasElement) {
    this.undoStack.push(element);
    this.redoStack.empty();
  }

  empty() {
    this.undoStack.empty();
    this.redoStack.empty();
  }
}

export const UndoRedo = new UndoRedoStack();
