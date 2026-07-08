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
  | { kind: 'raster'; layers: number[] }
  // A single user action that touched both subsystems (e.g. rasterize /
  // vectorize): undone/redone atomically so one Ctrl+Z reverts the whole thing.
  | { kind: 'compound'; tokens: UndoToken[] };

@Injectable({
  providedIn: 'root',
})
export class UndoRedoService {
  public redrawRequest: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );

  // One history stack per layer. A multi-layer action pushes a snapshot to each
  // affected layer's stack, so every layer always has a complete history.
  private layerUndoStacks =
    new Map<number, UndoRedo<LayerUndoRedoState>>();

  // Unified action timeline: the interleaved order of raster and vector actions
  // so a single Ctrl+Z undoes the most recent action regardless of its kind or
  // which layer it touched.
  private actionOrder: UndoToken[] = [];
  private redoOrder: UndoToken[] = [];

  // While a group is open, new tokens are buffered instead of appended to the
  // timeline; endGroup() folds them into one compound token (see beginGroup).
  private grouping = false;
  private groupBuffer: UndoToken[] = [];

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
      this.pushToken({ kind: 'vector' });
    });
  }

  /** Append a token to the timeline, or buffer it when a group is open. */
  private pushToken(token: UndoToken): void {
    if (this.grouping) {
      this.groupBuffer.push(token);
      return;
    }
    this.actionOrder.push(token);
    this.redoOrder = [];
  }

  // ==========================================
  // Grouped (compound) actions
  // ==========================================

  /**
   * Begin a compound action: any raster snapshots and vector commits recorded
   * until endGroup() collapse into a single timeline entry, so one undo reverts
   * them together. Used by rasterize/vectorize, which edit both subsystems.
   */
  beginGroup(): void {
    this.grouping = true;
    this.groupBuffer = [];
  }

  endGroup(): void {
    this.grouping = false;
    const buffer = this.groupBuffer;
    this.groupBuffer = [];
    if (buffer.length === 0) return;
    const token: UndoToken =
      buffer.length === 1 ? buffer[0] : { kind: 'compound', tokens: buffer };
    this.actionOrder.push(token);
    this.redoOrder = [];
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
      if (token.kind === 'compound') {
        this.actionOrder.pop();
        this.redoOrder.push(token);
        // Undo sub-actions in reverse; the subsystems are independent so the
        // final state is order-independent.
        for (let i = token.tokens.length - 1; i >= 0; i--) {
          const sub = token.tokens[i];
          if (sub.kind === 'vector') this.vectorEditor.undo();
          else if (sub.kind === 'raster') this.rasterUndo(sub.layers);
        }
        return;
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
      if (token.kind === 'compound') {
        this.redoOrder.pop();
        this.actionOrder.push(token);
        for (const sub of token.tokens) {
          if (sub.kind === 'vector') this.vectorEditor.redo();
          else if (sub.kind === 'raster') this.rasterRedo(sub.layers);
        }
        return;
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
      if (element && this.applyLayerState(element, index)) {
        changed = true;
        this.ioService.markLabelDirty(index); // restored pixels must be re-saved
      }
    }
    if (changed) this.afterRestore();
  }

  private rasterRedo(layers: number[]) {
    let changed = false;
    for (const index of layers) {
      const element = this.getLayerUndoRedo(index).redo();
      if (element && this.applyLayerState(element, index)) {
        changed = true;
        this.ioService.markLabelDirty(index);
      }
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
    this.snapshotLayers(this.affectedLayers());
  }

  /**
   * Snapshot an explicit set of layers as one raster action. Used by operations
   * that know exactly which masks they touched (e.g. rasterize), independent of
   * the current tool/label. Safe to call inside a group.
   */
  public snapshotLayers(layerIndices: number[]): void {
    const masks = this.canvasManagerService.getAllMasks();
    const layers = layerIndices.filter((i) => i >= 0 && masks[i]);
    if (layers.length === 0) return;

    for (const index of layers) {
      this.getLayerUndoRedo(index).push({ data: new Uint8Array(masks[index]) });
      this.ioService.markLabelDirty(index); // only these masks need re-saving
    }
    this.pushToken({ kind: 'raster', layers });
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
