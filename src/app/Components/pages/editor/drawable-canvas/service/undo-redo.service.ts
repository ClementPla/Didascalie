import { Injectable } from '@angular/core';
import { UndoRedo } from '../../../../../Core/misc/undo-redo';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { BehaviorSubject } from 'rxjs';
import { IOService } from '../../../../../Services/io.service';
import { VectorEditorService } from './vector-editor.service';

interface LayerUndoRedoState {
  data: OffscreenCanvas;
}

/** Which subsystem a tracked action belongs to, for unified undo ordering. */
type ActionKind = 'raster' | 'vector';

@Injectable({
  providedIn: 'root',
})
export class UndoRedoService {
  public redrawRequest: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );

  // Per-layer undo/redo stacks
  private layerUndoStacks: Map<number, UndoRedo<LayerUndoRedoState>> =
    new Map();

  // Global undo/redo for multi-layer operations
  private globalUndoRedo: UndoRedo<OffscreenCanvas[]> = new UndoRedo<
    OffscreenCanvas[]
  >();

  // Unified action timeline: the interleaved order of raster and vector actions
  // so a single Ctrl+Z undoes the most recent action regardless of its kind.
  private actionOrder: ActionKind[] = [];
  private redoOrder: ActionKind[] = [];

  constructor(
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private editorService: EditorService,
    private labelService: LabelsService,
    private ioService: IOService,
    private vectorEditor: VectorEditorService
  ) {
    this.editorService.undo.subscribe((value) => {
      if (value) {
        this.stateService.recomputeCanvasSum = true;
        this.undo();
      }
    });

    this.editorService.redo.subscribe((value) => {
      if (value) {
        this.stateService.recomputeCanvasSum = true;
        this.redo();
      }
    });

    // Every committed vector action joins the unified timeline.
    this.vectorEditor.committed$.subscribe(() => {
      this.actionOrder.push('vector');
      this.redoOrder = [];
    });
  }

  // ==========================================
  // Unified dispatch (raster + vector)
  // ==========================================

  /** Undo the most recent action across both subsystems. */
  async undo(): Promise<void> {
    while (this.actionOrder.length > 0) {
      const kind = this.actionOrder[this.actionOrder.length - 1];
      if (kind === 'vector') {
        if (this.vectorEditor.undo()) {
          this.actionOrder.pop();
          this.redoOrder.push('vector');
          return;
        }
        this.actionOrder.pop(); // stale token, drop and try the next one
        continue;
      }
      // Raster behaves exactly as before; its token is consumed regardless.
      this.actionOrder.pop();
      this.redoOrder.push('raster');
      await this.rasterUndo();
      return;
    }
  }

  /** Redo the most recently undone action across both subsystems. */
  async redo(): Promise<void> {
    while (this.redoOrder.length > 0) {
      const kind = this.redoOrder[this.redoOrder.length - 1];
      if (kind === 'vector') {
        if (this.vectorEditor.redo()) {
          this.redoOrder.pop();
          this.actionOrder.push('vector');
          return;
        }
        this.redoOrder.pop();
        continue;
      }
      this.redoOrder.pop();
      this.actionOrder.push('raster');
      await this.rasterRedo();
      return;
    }
  }

  /**
   * Get or create an UndoRedo instance for a specific layer
   */
  private getLayerUndoRedo(layerIndex: number): UndoRedo<LayerUndoRedoState> {
    if (!this.layerUndoStacks.has(layerIndex)) {
      this.layerUndoStacks.set(layerIndex, new UndoRedo<LayerUndoRedoState>());
    }
    return this.layerUndoStacks.get(layerIndex)!;
  }

  private async rasterUndo() {
    try {
      if (this.editorService.affectsMultipleLabels()) {
        // Global undo for multi-layer operations
        const element = this.globalUndoRedo.undo();
        if (!element) return;
        await this.restoreGlobalState(element);
      } else {
        // Per-layer undo
        const activeIndex = this.labelService.getActiveIndex();
        const layerUndoRedo = this.getLayerUndoRedo(activeIndex);
        const element = layerUndoRedo.undo();
        if (!element) return;
        await this.restoreLayerState(element, activeIndex);
      }
    } catch (error) {
      console.error('Error during undo:', error);
    }
  }

  private async rasterRedo() {
    try {
      if (this.editorService.affectsMultipleLabels()) {
        // Global redo for multi-layer operations
        const element = this.globalUndoRedo.redo();
        if (!element) return;
        await this.restoreGlobalState(element);
      } else {
        // Per-layer redo
        const activeIndex = this.labelService.getActiveIndex();
        const layerUndoRedo = this.getLayerUndoRedo(activeIndex);
        const element = layerUndoRedo.redo();
        if (!element) return;
        await this.restoreLayerState(element, activeIndex);
      }
    } catch (error) {
      console.error('Error during redo:', error);
    }
  }

  /**
   * Restore state for a single layer
   */
  private async restoreLayerState(
    element: LayerUndoRedoState,
    layerIndex: number
  ): Promise<void> {
    const allCtx = this.canvasManagerService.getAllCanvasCtx();
    const ctx = allCtx[layerIndex];

    if (!ctx) {
      console.error(`Context at index ${layerIndex} is null`);
      return;
    }

    const sourceCanvas = element.data;
    ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
    ctx.drawImage(sourceCanvas, 0, 0);
    this.ioService.markDirty();
    this.redrawRequest.next(true);
  }

  /**
   * Restore state for all layers (multi-layer operations)
   */
  private async restoreGlobalState(
    dataArray: OffscreenCanvas[]
  ): Promise<void> {
    const allCtx = this.canvasManagerService.getAllCanvasCtx();

    allCtx.forEach((ctx, index) => {
      if (!ctx) {
        console.warn(`Context at index ${index} is null`);
        return;
      }
      const sourceCanvas = dataArray[index];
      ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
      ctx.drawImage(sourceCanvas, 0, 0);
    });
    this.ioService.markDirty();
    this.redrawRequest.next(true);
  }

  /**
   * Clear all undo/redo history
   */
  empty() {
    this.layerUndoStacks.clear();
    this.globalUndoRedo.empty();
    this.actionOrder = [];
    this.redoOrder = [];
  }

  /**
   * Clear undo/redo history for a specific layer
   */
  emptyLayer(layerIndex: number) {
    if (this.layerUndoStacks.has(layerIndex)) {
      this.layerUndoStacks.get(layerIndex)!.empty();
    }
  }

  /**
   * Remove a layer's undo/redo stack (call when deleting a layer)
   */
  removeLayer(layerIndex: number) {
    this.layerUndoStacks.delete(layerIndex);
  }

  /**
   * Update undo/redo state after a canvas modification
   */
  public async updateUndoRedo(): Promise<void> {
    if (this.editorService.affectsMultipleLabels()) {
      // Save all layers for global operations
      const allCanvas = this.canvasManagerService.getAllCanvas();
      const clonedCanvases = allCanvas.map((canvas) => {
        const clone = new OffscreenCanvas(canvas.width, canvas.height);
        const cloneCtx = clone.getContext('2d');
        cloneCtx?.drawImage(canvas, 0, 0);
        return clone;
      });
      this.globalUndoRedo.push(clonedCanvases);
    } else {
      // Save current layer state
      const activeIndex = this.labelService.getActiveIndex();
      const activeCanvas = this.canvasManagerService.getActiveCanvas();

      const clone = new OffscreenCanvas(
        activeCanvas.width,
        activeCanvas.height
      );
      const cloneCtx = clone.getContext('2d');
      cloneCtx?.drawImage(activeCanvas, 0, 0);

      const layerUndoRedo = this.getLayerUndoRedo(activeIndex);
      layerUndoRedo.push({ data: clone });
    }

    // Record this raster action in the unified timeline; a new action
    // invalidates the redo history.
    this.actionOrder.push('raster');
    this.redoOrder = [];
  }

  /**
   * Check if undo is available for current context
   */
  canUndo(): boolean {
    if (this.editorService.affectsMultipleLabels()) {
      return this.globalUndoRedo.canUndo();
    } else {
      const activeIndex = this.labelService.getActiveIndex();
      const layerUndoRedo = this.getLayerUndoRedo(activeIndex);
      return layerUndoRedo.canUndo();
    }
  }

  /**
   * Check if redo is available for current context
   */
  canRedo(): boolean {
    if (this.editorService.affectsMultipleLabels()) {
      return this.globalUndoRedo.canRedo();
    } else {
      const activeIndex = this.labelService.getActiveIndex();
      const layerUndoRedo = this.getLayerUndoRedo(activeIndex);
      return layerUndoRedo.canRedo();
    }
  }

  /**
   * Get debug info about undo/redo stacks
   */
  getDebugInfo(): any {
    return {
      globalStackSize: this.globalUndoRedo.size(),
      layerStacks: Array.from(this.layerUndoStacks.entries()).map(
        ([index, stack]) => ({
          layerIndex: index,
          stackSize: stack.size(),
        })
      ),
    };
  }

  /**
   * Capture initial state for all layers (call after loading canvases)
   */
  public async captureInitialStates(): Promise<void> {
    const allCanvas = this.canvasManagerService.getAllCanvas();

    allCanvas.forEach((canvas, index) => {
      const clone = new OffscreenCanvas(canvas.width, canvas.height);
      const cloneCtx = clone.getContext('2d');
      cloneCtx?.drawImage(canvas, 0, 0);

      const layerUndoRedo = this.getLayerUndoRedo(index);
      layerUndoRedo.push({ data: clone });
    });

  }

  /**
   * Capture initial state for a specific layer (call after loading a single canvas)
   */
  public async captureInitialState(layerIndex: number): Promise<void> {
    const allCanvas = this.canvasManagerService.getAllCanvas();
    const canvas = allCanvas[layerIndex];

    if (!canvas) {
      console.error(`Canvas at index ${layerIndex} not found`);
      return;
    }

    const clone = new OffscreenCanvas(canvas.width, canvas.height);
    const cloneCtx = clone.getContext('2d');
    cloneCtx?.drawImage(canvas, 0, 0);

    const layerUndoRedo = this.getLayerUndoRedo(layerIndex);
    layerUndoRedo.push({ data: clone });

  }
}
