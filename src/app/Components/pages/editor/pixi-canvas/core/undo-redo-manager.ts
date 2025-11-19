/**
 * Manages undo/redo history for drawing operations
 * Stores complete layer states as ImageData
 */
export class UndoRedoManager {
  private undoStack: Map<string, ImageData>[] = [];
  private redoStack: Map<string, ImageData>[] = [];
  private maxHistorySize: number;

  constructor(maxHistorySize: number = 50) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Save current state to undo stack
   */
  public saveState(layerStates: Map<string, ImageData>): void {
    // Clone the states to avoid reference issues
    const clonedStates = this.cloneStates(layerStates);

    this.undoStack.push(clonedStates);

    // Limit stack size
    if (this.undoStack.length > this.maxHistorySize) {
      this.undoStack.shift();
    }

    // Clear redo stack when new action is performed
    this.redoStack = [];
  }

  /**
   * Undo last action
   * Returns the previous state or null if no undo available
   */
  public undo(
    currentStates: Map<string, ImageData>
  ): Map<string, ImageData> | null {
    if (this.undoStack.length === 0) {
      return null;
    }

    // Save current state to redo stack
    const clonedCurrent = this.cloneStates(currentStates);
    this.redoStack.push(clonedCurrent);

    // Pop and return previous state
    const previousState = this.undoStack.pop()!;
    return previousState;
  }

  /**
   * Redo last undone action
   * Returns the next state or null if no redo available
   */
  public redo(
    currentStates: Map<string, ImageData>
  ): Map<string, ImageData> | null {
    if (this.redoStack.length === 0) {
      return null;
    }

    // Save current state to undo stack
    const clonedCurrent = this.cloneStates(currentStates);
    this.undoStack.push(clonedCurrent);

    // Pop and return next state
    const nextState = this.redoStack.pop()!;
    return nextState;
  }

  /**
   * Check if undo is available
   */
  public canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /**
   * Check if redo is available
   */
  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /**
   * Clear all history
   */
  public clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  /**
   * Get undo stack size
   */
  public getUndoStackSize(): number {
    return this.undoStack.length;
  }

  /**
   * Get redo stack size
   */
  public getRedoStackSize(): number {
    return this.redoStack.length;
  }

  /**
   * Clone layer states for storage
   */
  private cloneStates(states: Map<string, ImageData>): Map<string, ImageData> {
    const cloned = new Map<string, ImageData>();

    states.forEach((imageData, id) => {
      // Create a new ImageData with copied data
      const clonedData = new ImageData(
        new Uint8ClampedArray(imageData.data),
        imageData.width,
        imageData.height
      );
      cloned.set(id, clonedData);
    });

    return cloned;
  }

  /**
   * Get memory usage estimate (in MB)
   */
  public getMemoryUsage(): number {
    let totalBytes = 0;

    this.undoStack.forEach((states) => {
      states.forEach((imageData) => {
        totalBytes += imageData.data.length;
      });
    });

    this.redoStack.forEach((states) => {
      states.forEach((imageData) => {
        totalBytes += imageData.data.length;
      });
    });

    return totalBytes / (1024 * 1024); // Convert to MB
  }
}
