import { Injectable, inject } from '@angular/core';
import { UndoRedo } from '../../../../core/misc/undo-redo';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../services/labels/labels.service';
import { BehaviorSubject } from 'rxjs';
import { IOService } from '../../../../services/io.service';
import { VectorEditorService } from './vector-editor.service';
import { ProjectScoped } from '../../../../core/project-scoped';

interface LayerUndoRedoState {
  data: Uint8Array;
}

/**
 * An action that undoes and redoes itself, recorded in the editor's timeline.
 * For edits made outside the current frame's layers (e.g. painting on the
 * projection view, which writes many slices).
 *
 * `undo` / `redo` return the indices of the current frame's layers they
 * modified, or `null` when the action no longer applies: it is then dropped.
 * They may be asynchronous (an operation stored in the project).
 */
export interface ExternalAction {
  undo(): number[] | null | Promise<number[] | null>;
  redo(): number[] | null | Promise<number[] | null>;
  /** Groups actions to drop together (`dropExternals`). */
  tag?: string;
}

/** One entry of the undo timeline. A raster action records which layers it
 *  snapshotted. */
type UndoToken =
  | { kind: 'vector' }
  | { kind: 'raster'; layers: number[] }
  // One user action that touched both raster and vector (e.g. rasterize).
  | { kind: 'compound'; tokens: UndoToken[] }
  | { kind: 'external'; action: ExternalAction };

@Injectable({
  providedIn: 'root',
})
export class UndoRedoService implements ProjectScoped {
  private canvasManagerService = inject(CanvasManagerService);
  private stateService = inject(StateManagerService);
  private editorService = inject(EditorService);
  private labelService = inject(LabelsService);
  private ioService = inject(IOService);
  private vectorEditor = inject(VectorEditorService);

  public redrawRequest: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );

  // One history stack per layer.
  private layerUndoStacks =
    new Map<number, UndoRedo<LayerUndoRedoState>>();

  // The interleaved order of raster and vector actions.
  private actionOrder: UndoToken[] = [];
  private redoOrder: UndoToken[] = [];

  // While a group is open, tokens are buffered; `endGroup()` folds them into
  // one compound token.
  private grouping = false;
  private groupBuffer: UndoToken[] = [];

  constructor() {
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

    this.vectorEditor.committed$.subscribe(() => {
      this.pushToken({ kind: 'vector' });
    });
  }

  private pushToken(token: UndoToken): void {
    if (this.grouping) {
      this.groupBuffer.push(token);
      return;
    }
    this.actionOrder.push(token);
    this.redoOrder = [];
  }

  /**
   * Record an action that was just applied outside this service. `layers` are
   * the current frame's layers it modified: their history is rebased on the
   * new contents.
   */
  pushExternal(action: ExternalAction, layers: number[]): void {
    this.rebaseLayers(layers);
    this.pushToken({ kind: 'external', action });
  }

  /** Make each layer's current history state match its mask again. */
  private rebaseLayers(layers: number[]): void {
    const masks = this.canvasManagerService.getAllMasks();
    for (const index of layers) {
      if (masks[index]) this.getLayerUndoRedo(index).replaceCurrent({ data: new Uint8Array(masks[index]) });
    }
  }

  /** Forget the external actions tagged `tag` (their context is gone). */
  dropExternals(tag: string): void {
    const keep = (t: UndoToken) => !(t.kind === 'external' && t.action.tag === tag);
    this.actionOrder = this.actionOrder.filter(keep);
    this.redoOrder = this.redoOrder.filter(keep);
  }

  /** Run an external action's undo or redo; false when it is stale. */
  private async runExternal(action: ExternalAction, direction: 'undo' | 'redo'): Promise<boolean> {
    const layers = await (direction === 'undo' ? action.undo() : action.redo());
    if (layers === null) return false;
    this.rebaseLayers(layers);
    this.afterRestore();
    return true;
  }

  // ── Grouped (compound) actions ───────────────────────────────────────────

  /** Begin a compound action: what is recorded until `endGroup()` becomes one
   *  timeline entry. */
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

  // ── Unified dispatch (raster + vector) ───────────────────────────────────

  /** An undo or redo is running (an external one can take a while). */
  private running = false;

  async undo(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.undoStep();
    } finally {
      this.running = false;
    }
  }

  async redo(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.redoStep();
    } finally {
      this.running = false;
    }
  }

  private async undoStep(): Promise<void> {
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
      if (token.kind === 'external') {
        this.actionOrder.pop();
        if (await this.runExternal(token.action, 'undo')) {
          this.redoOrder.push(token);
          return;
        }
        continue; // stale: dropped
      }
      if (token.kind === 'compound') {
        this.actionOrder.pop();
        this.redoOrder.push(token);
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

  private async redoStep(): Promise<void> {
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
      if (token.kind === 'external') {
        this.redoOrder.pop();
        if (await this.runExternal(token.action, 'redo')) {
          this.actionOrder.push(token);
          return;
        }
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

  /** Clear the current frame's history (a frame was loaded). External actions
   *  survive: they span frames and drop themselves when stale. */
  empty() {
    this.layerUndoStacks.clear();
    this.actionOrder = this.actionOrder.filter((t) => t.kind === 'external');
    this.redoOrder = this.redoOrder.filter((t) => t.kind === 'external');
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.empty();
    this.actionOrder = [];
    this.redoOrder = [];
    this.grouping = false;
    this.groupBuffer = [];
  }

  /** The layers a raster action snapshots: the active one, or all of them for
   *  erase-all and swap. */
  private affectedLayers(): number[] {
    if (this.editorService.affectsMultipleLabels()) {
      return this.canvasManagerService.getAllMasks().map((_, i) => i);
    }
    return [this.labelService.getActiveIndex()];
  }

  /** Record a raster modification. */
  public async updateUndoRedo(): Promise<void> {
    this.snapshotLayers(this.affectedLayers());
  }

  /** Snapshot an explicit set of layers as one raster action. */
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

  /** Give every layer stack a baseline, so the first action on it can be
   *  undone. Call after loading masks. */
  public async captureInitialStates(): Promise<void> {
    this.canvasManagerService.getAllMasks().forEach((mask, index) => {
      this.getLayerUndoRedo(index).push({ data: new Uint8Array(mask) });
    });
  }
}
