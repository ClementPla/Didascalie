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
  data: Uint8Array;
}

/**
 * One entry in the unified undo timeline. A raster action records exactly which
 * layer(s) it snapshotted, so undo/redo route to those layers' stacks
 * regardless of which layer is active now (or what the current tool mode is).
 * Multi-layer operations simply list every layer they touched.
 */
type UndoToken =
  | { kind: 'vector' }
  | { kind: 'raster'; layers: number[] };

@Injectable({
  providedIn: 'root',
})
export class UndoRedoService {
  public redrawRequest: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );

  // One history stack per layer. A multi-layer action pushes a snapshot to each
  // affected layer's stack, so every layer always has a complete history.
  private layerUndoStacks: Map<number, UndoRedo<LayerUndoRedoState>> =
    new Map();

  // Unified action timeline: the interleaved order of raster and vector actions
  // so a single Ctrl+Z undoes the most recent action regardless of its kind or
  // which layer it touched.
  private actionOrder: UndoToken[] = [];
  private redoOrder: UndoToken[] = [];

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
      this.actionOrder.push({ kind: 'vector' });
      this.redoOrder = [];
    });
  }

  // ==========================================
  // Unified dispatch (raster + vector)
  // ==========================================

  /** Undo the most recent action across both subsystems. */
  async undo(): Promise<void> {
    while (this.actionOrder.length > 0) {
      const token = this.actionOrder[this.actionOrder.length - 1];
      if (token.kind === 'vector') {
        if (this.vectorEditor.undo()) {
          this.actionOrder.pop();
          this.redoOrder.push(token);
          return;
        }
        this.actionOrder.pop(); // stale token, drop and try the next one
        continue;
      }
      this.actionOrder.pop();
      this.redoOrder.push(token);
      this.rasterUndo(token.layers);
      return;
    }
  }

  /** Redo the most recently undone action across both subsystems. */
  async redo(): Promise<void> {
    while (this.redoOrder.length > 0) {
      const token = this.redoOrder[this.redoOrder.length - 1];
      if (token.kind === 'vector') {
        if (this.vectorEditor.redo()) {
          this.redoOrder.pop();
          this.actionOrder.push(token);
          return;
        }
        this.redoOrder.pop();
        continue;
      }
      this.redoOrder.pop();
      this.actionOrder.push(token);
      this.rasterRedo(token.layers);
      return;
    }
  }

  private getLayerUndoRedo(layerIndex: number): UndoRedo<LayerUndoRedoState> {
    if (!this.layerUndoStacks.has(layerIndex)) {
      this.layerUndoStacks.set(layerIndex, new UndoRedo<LayerUndoRedoState>());
    }
    return this.layerUndoStacks.get(layerIndex)!;
  }

  private rasterUndo(layers: number[]) {
    let changed = false;
    for (const index of layers) {
      const element = this.getLayerUndoRedo(index).undo();
      if (element) changed = this.applyLayerState(element, index) || changed;
    }
    if (changed) this.afterRestore();
  }

  private rasterRedo(layers: number[]) {
    let changed = false;
    for (const index of layers) {
      const element = this.getLayerUndoRedo(index).redo();
      if (element) changed = this.applyLayerState(element, index) || changed;
    }
    if (changed) this.afterRestore();
  }

  /** Copy a snapshot back into a layer mask. Returns false if the layer is gone. */
  private applyLayerState(element: LayerUndoRedoState, layerIndex: number): boolean {
    const mask = this.canvasManagerService.getAllMasks()[layerIndex];
    if (!mask) return false;
    mask.set(element.data);
    return true;
  }

  private afterRestore() {
    this.ioService.markDirty();
    this.redrawRequest.next(true);
  }

  /**
   * Clear all undo/redo history
   */
  empty() {
    this.layerUndoStacks.clear();
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

  /** The layer indices a raster action snapshots: the active one, or all of
   *  them for multi-layer operations (erase-all, swap). */
  private affectedLayers(): number[] {
    if (this.editorService.affectsMultipleLabels()) {
      return this.canvasManagerService.getAllMasks().map((_, i) => i);
    }
    return [this.labelService.getActiveIndex()];
  }

  /**
   * Record a raster modification: snapshot each affected layer and append the
   * action to the unified timeline.
   */
  public async updateUndoRedo(): Promise<void> {
    const masks = this.canvasManagerService.getAllMasks();
    const layers = this.affectedLayers().filter((i) => i >= 0 && masks[i]);

    for (const index of layers) {
      this.getLayerUndoRedo(index).push({ data: new Uint8Array(masks[index]) });
    }

    // A new action invalidates the redo history.
    this.actionOrder.push({ kind: 'raster', layers });
    this.redoOrder = [];
  }

  canUndo(): boolean {
    return this.actionOrder.length > 0;
  }

  canRedo(): boolean {
    return this.redoOrder.length > 0;
  }

  getDebugInfo(): any {
    return {
      actions: this.actionOrder.length,
      redos: this.redoOrder.length,
      layerStacks: Array.from(this.layerUndoStacks.entries()).map(
        ([index, stack]) => ({ layerIndex: index, stackSize: stack.size() })
      ),
    };
  }

  /**
   * Capture initial state for all layers (call after loading masks). Every
   * layer stack starts with a baseline so the first action on it is undoable.
   */
  public async captureInitialStates(): Promise<void> {
    this.canvasManagerService.getAllMasks().forEach((mask, index) => {
      this.getLayerUndoRedo(index).push({ data: new Uint8Array(mask) });
    });
  }

  /**
   * Capture initial state for a specific layer (call after loading a single mask)
   */
  public async captureInitialState(layerIndex: number): Promise<void> {
    const mask = this.canvasManagerService.getAllMasks()[layerIndex];
    if (!mask) {
      console.error(`Mask at index ${layerIndex} not found`);
      return;
    }
    this.getLayerUndoRedo(layerIndex).push({ data: new Uint8Array(mask) });
  }
}
