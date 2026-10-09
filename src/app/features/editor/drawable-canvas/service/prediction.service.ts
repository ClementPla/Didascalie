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

/** Upper bound on traced shapes. A fragmented prediction can otherwise drop
 *  hundreds of specks into the editor, each needing manual deletion. */
const MAX_TRACED_SHAPES = 64;
import { VectorEditorService } from './vector-editor.service';
import { OrchestratorService } from './orchestrator.service';
import { base64ToUint8 } from '../../../../core/misc/base64';

/**
 * Applies the trained segmentation head to the frame currently open in the
 * editor.
 *
 * # Why this is undoable rather than confirmed
 *
 * A prediction overwrites every label layer, which would otherwise discard work
 * silently. Rather than interrupt with a dialog on each run — the point is to
 * predict, correct, predict again — the whole replacement is pushed as one undo
 * group, so a single Ctrl+Z restores exactly what was there before.
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
    // Prediction on a large frame takes seconds; a bare spinner leaves the user
    // guessing. Tauri callbacks fire outside Angular's zone, so this must be
    // wrapped or the signal updates without ever repainting.
    void listen<{ stage: string }>('ml-progress', (e) =>
      this.zone.run(() => {
        if (this.running()) this.stage.set(e.payload.stage);
      }),
    );
  }

  /** Enter the running state. Paired with `endRun`: anything scoped to one
   *  prediction is reset in these two places only. */
  private beginRun(): void {
    this.running.set(true);
    this.stage.set(null);
    this.lastError.set(null);
  }

  /** Leave the running state, clearing anything scoped to one prediction. */
  private endRun(): void {
    this.running.set(false);
    this.stage.set(null);
  }

  /**
   * Turn what the user has already drawn into scribble conditioning.
   *
   * The head's conditioning is binary, so the mapping is: pixels of the
   * **active** label are positive, pixels of any **other** label are negative.
   * That reads naturally in the editor — mark some of the thing you want, mark
   * some of what you don't — and needs no separate scribble tool.
   *
   * Returns `undefined` when nothing is drawn, which the backend treats as an
   * unconditioned prediction rather than as an error.
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

  /**
   * Predict the open frame and load the result into the label layers.
   *
   * @param useScribbles condition on the current annotation. Turning this off
   * shows what the model does unaided.
   */
  /**
   * Turn a traced polygon into an editable path.
   *
   * Corner nodes (handles coincident with the anchor), not smoothed curves: the
   * points come from a pixel contour, so inventing tangents would imply a
   * precision the mask does not have and would pull the outline off the
   * boundary the model actually predicted. The user can smooth what they want.
   */
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
      // An open centerline has no interior to fill; filling one would paint the
      // chord between its endpoints.
      filled: closed,
      nodes,
    };
  }

  /**
   * Apply a prediction as vector shapes rather than painted pixels.
   *
   * The model still predicts a raster mask — this vectorises its output. That
   * keeps the dense training signal the head needs while giving back something
   * the node editor can actually adjust.
   *
   * `regions` traces each blob's outline into a closed, filled shape.
   * `centerlines` thins each blob to its 1px skeleton and returns open paths —
   * the right output when the structure is a curve rather than an area (a
   * vessel, a nerve, a fibre, a crack), where an outline says nothing useful and
   * the thing you actually want to measure is the path down the middle.
   */
  private async predictAsShapes(
    useScribbles: boolean,
    mode: 'regions' | 'centerlines',
  ): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    // Re-entry guard: a prediction takes seconds, and a second click would run
    // a concurrent one that overwrites the first's result and leaves `running`
    // cleared while work is still in flight.
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

      // addShapes commits its own undo entry, so the whole set reverts at once.
      this.vectorEditor.addShapes(shapes);
      // Say when the cap bit. Silently keeping the largest 64 of 300 blobs
      // would look like the model missed things it actually found. Only
      // meaningful for regions: skeletonizeMask caps *components*, and one
      // branched structure yields several polylines, so the shape count here
      // says nothing about whether the cap was reached.
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

  /** Predict, then trace each region's outline into an editable closed path. */
  async predictCurrentFrameAsVectors(useScribbles = true): Promise<void> {
    return this.predictAsShapes(useScribbles, 'regions');
  }

  /** Predict, then reduce each region to its centerline as an open path. */
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

      // Snapshot before mutating so the whole replacement is one undo step.
      this.undoRedo.beginGroup();
      this.undoRedo.snapshotLayers(touched);
      for (const { index, mask } of applied) {
        this.canvasManager.setMask(index, mask);
        this.io.markLabelDirty(index);
      }
      this.undoRedo.endGroup();
      // Marks the composite stale and schedules a frame; the flag alone would
      // leave the prediction invisible until the next repaint.
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
