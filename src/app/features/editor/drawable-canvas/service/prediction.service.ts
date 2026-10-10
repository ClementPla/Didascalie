import { Injectable, NgZone, signal, inject } from '@angular/core';
import { listen } from '@tauri-apps/api/event';

import { LabelsService } from '../../../../services/labels/labels.service';
import { SequenceService } from '../../../../services/sequence.service';
import { IOService } from '../../../../services/io.service';
import { NotificationService } from '../../../../services/notification.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { UndoRedoService } from './undo-redo.service';

import { api, ScribbleInput, VectorShape, VectorNode } from '../../../../lib/api';

/** Upper bound on traced shapes. */
const MAX_TRACED_SHAPES = 64;
import { VectorEditorService } from './vector-editor.service';
import { OrchestratorService } from './orchestrator.service';
import { base64ToUint8 } from '../../../../core/misc/base64';

/**
 * Applies the trained segmentation head to the frame open in the editor. A
 * prediction overwrites every label layer, as one undo group.
 */
@Injectable({ providedIn: 'root' })
export class PredictionService {
  private labelService = inject(LabelsService);
  private sequenceService = inject(SequenceService);
  private canvasManager = inject(CanvasManagerService);
  private stateManager = inject(StateManagerService);
  private undoRedo = inject(UndoRedoService);
  private io = inject(IOService);
  private notifications = inject(NotificationService);
  private vectorEditor = inject(VectorEditorService);
  private orchestrator = inject(OrchestratorService);
  private zone = inject(NgZone);

  readonly running = signal(false);
  readonly lastError = signal<string | null>(null);
  /** Coarse phase of the in-flight prediction, e.g. "encoder". */
  readonly stage = signal<string | null>(null);

  constructor() {
    // Tauri callbacks fire outside Angular's zone.
    void listen<{ stage: string }>('ml-progress', (e) =>
      this.zone.run(() => {
        if (this.running()) this.stage.set(e.payload.stage);
      }),
    );
  }

  private beginRun(): void {
    this.running.set(true);
    this.stage.set(null);
    this.lastError.set(null);
  }

  private endRun(): void {
    this.running.set(false);
    this.stage.set(null);
  }

  /**
   * What the user has drawn, as scribble conditioning: pixels of the active
   * label are positive, pixels of any other label negative. `undefined` when
   * nothing is drawn.
   */
  private deriveScribbles(): ScribbleInput | undefined {
    const labels = this.labelService.listSegmentationLabels;
    const active = this.labelService.activeLabel;
    const activeIndex = active ? labels.indexOf(active) : -1;
    const masks = this.canvasManager.getAllMasks();
    if (!masks.length) return undefined;

    const positive: number[] = [];
    const negative: number[] = [];
    for (let li = 0; li < masks.length; li++) {
      const mask = masks[li];
      if (!mask) continue;
      const sink = li === activeIndex ? positive : negative;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] > 0) sink.push(i);
      }
    }
    if (!positive.length && !negative.length) return undefined;
    return { positive, negative };
  }

  /** A traced polygon as an editable path, with corner nodes: the points come
   *  from a pixel contour, and tangents would imply a precision it lacks. */
  private polygonToShape(
    poly: number[][],
    labelId: number,
    closed: boolean,
  ): VectorShape {
    const nodes: VectorNode[] = poly.map(([x, y]) => ({
      x,
      y,
      inX: x,
      inY: y,
      outX: x,
      outY: y,
      smooth: false,
    }));
    return {
      id: crypto.randomUUID(),
      labelId,
      closed,
      // An open centreline is not filled.
      filled: closed,
      nodes,
    };
  }

  /**
   * Apply a prediction as vector shapes: the predicted mask is vectorized.
   * `regions` traces each blob's outline into a closed, filled shape;
   * `centerlines` thins each blob to its skeleton and returns open paths.
   */
  private async predictAsShapes(
    useScribbles: boolean,
    mode: 'regions' | 'centerlines',
  ): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    // A second click must not start a concurrent prediction.
    if (!frame || this.running()) return;

    this.beginRun();
    try {
      const scribbles = useScribbles ? this.deriveScribbles() : undefined;
      const result = await api.mlPredictFrame(frame.id, scribbles);
      const labels = this.labelService.listSegmentationLabels;

      const shapes: VectorShape[] = [];
      for (const m of result.masks) {
        if (!labels.some((l) => l.id === m.labelId)) continue;
        const mask = base64ToUint8(m.maskBase64);
        const traced =
          mode === 'regions'
            ? await api.vectorizeMask(
                mask,
                result.width,
                result.height,
                64,
                MAX_TRACED_SHAPES,
              )
            : await api.skeletonizeMask(
                mask,
                result.width,
                result.height,
                64,
                MAX_TRACED_SHAPES,
              );
        for (const p of traced) {
          shapes.push(this.polygonToShape(p, m.labelId, mode === 'regions'));
        }
      }

      if (!shapes.length) {
        this.notifications.warn(
          'Nothing applied',
          mode === 'regions'
            ? 'The prediction produced no traceable regions.'
            : 'The prediction produced no traceable centerlines.',
        );
        return;
      }

      this.vectorEditor.addShapes(shapes);
      // Say when the cap was reached. Regions only: `skeletonizeMask` caps
      // components, and one of them can yield several polylines.
      const capped = mode === 'regions' && shapes.length >= MAX_TRACED_SHAPES;
      const noun = mode === 'regions' ? 'shape' : 'centerline';
      this.notifications.notify({
        severity: capped ? 'warn' : 'success',
        summary: capped ? 'Traced the largest regions' : 'Prediction traced',
        detail: capped
          ? `Kept the ${shapes.length} largest regions — the prediction is fragmented`
          : `${shapes.length} ${noun}${shapes.length === 1 ? '' : 's'} — Ctrl+Z to revert`,
        life: 4000,
      });
    } catch (error) {
      const message = String(error);
      this.lastError.set(message);
      this.notifications.error('Prediction failed', message);
    } finally {
      this.endRun();
    }
  }

  async predictCurrentFrameAsVectors(useScribbles = true): Promise<void> {
    return this.predictAsShapes(useScribbles, 'regions');
  }

  async predictCurrentFrameAsSkeletons(useScribbles = true): Promise<void> {
    return this.predictAsShapes(useScribbles, 'centerlines');
  }

  async predictCurrentFrame(useScribbles = true): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame || this.running()) return;

    this.beginRun();
    try {
      const scribbles = useScribbles ? this.deriveScribbles() : undefined;
      const result = await api.mlPredictFrame(frame.id, scribbles);

      const labels = this.labelService.listSegmentationLabels;
      const touched: number[] = [];
      const applied: { index: number; mask: Uint8Array }[] = [];
      for (const m of result.masks) {
        const index = labels.findIndex((l) => l.id === m.labelId);
        if (index < 0) continue;
        touched.push(index);
        applied.push({ index, mask: base64ToUint8(m.maskBase64) });
      }

      if (!applied.length) {
        this.notifications.warn(
          'Nothing applied',
          'The model returned no labels matching this project.',
        );
        return;
      }

      // One undo step for the whole replacement.
      this.undoRedo.beginGroup();
      this.undoRedo.snapshotLayers(touched);
      for (const { index, mask } of applied) {
        this.canvasManager.setMask(index, mask);
        this.io.markLabelDirty(index);
      }
      this.undoRedo.endGroup();
      this.orchestrator.requestRedrawAllCanvas();

      const covered = result.masks
        .filter((m) => m.coverage > 0)
        .map((m) => `${(m.coverage * 100).toFixed(1)}%`)
        .join(' · ');
      this.notifications.notify({
        severity: 'success',
        summary: 'Prediction applied',
        detail: covered ? `Coverage ${covered} — Ctrl+Z to revert` : 'Ctrl+Z to revert',
        life: 3000,
      });
    } catch (error) {
      const message = String(error);
      this.lastError.set(message);
      this.notifications.error('Prediction failed', message);
    } finally {
      this.endRun();
    }
  }
}
