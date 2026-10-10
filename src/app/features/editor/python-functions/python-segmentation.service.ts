import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { listen } from '@tauri-apps/api/event';

import { api, PythonFunction, PythonSegContext } from '../../../lib/api';
import { InferenceClientService } from '../../../services/inference-client.service';
import { IOService } from '../../../services/io.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { PropagationService } from '../../../services/labels/propagation.service';
import { NotificationService } from '../../../services/notification.service';
import { ProjectService } from '../../../services/project/project.service';
import { SequenceService } from '../../../services/sequence.service';
import { CanvasManagerService } from '../drawable-canvas/service/canvas-manager.service';
import { OrchestratorService } from '../drawable-canvas/service/orchestrator.service';
import { UndoRedoService } from '../drawable-canvas/service/undo-redo.service';
import { base64ToUint8 } from '../../../core/misc/base64';

/** Which frames a sequence function is given. */
export type SequenceRunScope = 'all' | 'fromCurrent';

export interface SequenceRunProgress {
  stage: 'sending' | 'running' | 'receiving';
  done: number;
  total: number;
}

/**
 * Runs the user's Python segmentation functions from the editor. A frame
 * function's masks are applied to the canvas as one undo step; a sequence
 * function writes straight to the project, behind a confirmation.
 */
@Injectable({ providedIn: 'root' })
export class PythonSegmentationService {
  private readonly inference = inject(InferenceClientService);
  private readonly sequenceService = inject(SequenceService);
  private readonly labelService = inject(LabelsService);
  private readonly canvasManager = inject(CanvasManagerService);
  private readonly projectService = inject(ProjectService);
  private readonly undoRedo = inject(UndoRedoService);
  private readonly orchestrator = inject(OrchestratorService);
  private readonly io = inject(IOService);
  private readonly propagation = inject(PropagationService);
  private readonly notifications = inject(NotificationService);
  private readonly zone = inject(NgZone);

  readonly frameFunctions = this.inference.segFunctions;

  /** Sequence functions, offered only where there is a sequence to run on. */
  readonly sequenceFunctions = computed(() =>
    this.sequenceService.frameCount() > 1
      ? this.inference.sequenceSegFunctions()
      : [],
  );

  readonly available = computed(
    () =>
      this.frameFunctions().length > 0 || this.sequenceFunctions().length > 0,
  );

  /** Name of the function in flight. One at a time: the Python server is
   *  single-threaded. */
  readonly running = signal<string | null>(null);
  readonly progress = signal<SequenceRunProgress | null>(null);

  constructor() {
    // Tauri callbacks fire outside Angular's zone.
    void listen<SequenceRunProgress>('python-seg-progress', (e) =>
      this.zone.run(() => {
        if (this.running()) this.progress.set(e.payload);
      }),
    );
  }

  /** Frames a sequence run would send, in order. */
  targetFrameIds(scope: SequenceRunScope): number[] {
    const frames = this.sequenceService.frames();
    const from = scope === 'all' ? 0 : this.sequenceService.currentFrameIndex();
    return frames.slice(from).map((f) => f.id);
  }

  private context(fn: PythonFunction): PythonSegContext {
    return {
      labels: this.labelService.listSegmentationLabels.map((l) => ({
        id: l.id,
        name: l.label,
        isInstance: l.shades !== null,
      })),
      activeLabelId: this.labelService.activeLabel?.id ?? null,
      activeValue: this.labelService.paintValue(
        this.projectService.isInstanceSegmentation(),
      ),
      sendMasks: fn.wants.includes('masks'),
    };
  }

  async runOnFrame(fn: PythonFunction): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame || this.running()) return;

    this.running.set(fn.name);
    try {
      const context = this.context(fn);
      // The backend sends what is stored.
      if (context.sendMasks) await this.io.saveIfDirty();

      const result = await this.inference.track(() =>
        api.pythonSegmentFrame(
          fn.name,
          frame.id,
          this.sequenceService.currentFrameIndex(),
          context,
        ),
      );

      if (this.sequenceService.currentFrame()?.id !== frame.id) {
        this.notifications.warn(
          `${fn.name}: result discarded`,
          'The frame changed while the function was running.',
        );
        return;
      }

      const labels = this.labelService.listSegmentationLabels;
      const applied = result.layers
        .map((layer) => ({
          index: labels.findIndex((l) => l.id === layer.labelId),
          additive: layer.additive,
          mask: base64ToUint8(layer.maskBase64),
        }))
        .filter((layer) => layer.index >= 0);

      if (!applied.length) {
        this.notifications.warn(
          `${fn.name}: nothing applied`,
          this.unknownDetail(result.unknownLabels) ??
            'The function returned no masks.',
        );
        return;
      }

      // One undo step for the whole run.
      const masks = this.canvasManager.getAllMasks();
      this.undoRedo.beginGroup();
      this.undoRedo.snapshotLayers(applied.map((l) => l.index));
      for (const { index, additive, mask } of applied) {
        if (additive) {
          const target = masks[index];
          const length = Math.min(target.length, mask.length);
          for (let i = 0; i < length; i++) {
            if (mask[i]) target[i] = mask[i];
          }
        } else {
          this.canvasManager.setMask(index, mask);
        }
        this.io.markLabelDirty(index);
      }
      this.undoRedo.endGroup();
      this.orchestrator.requestRedrawAllCanvas();

      const unknown = this.unknownDetail(result.unknownLabels);
      this.notifications.notify({
        severity: unknown ? 'warn' : 'success',
        summary: `${fn.name} applied`,
        detail: unknown ? `${unknown} Ctrl+Z to revert.` : 'Ctrl+Z to revert',
        life: unknown ? 6000 : 3000,
      });
    } catch (error) {
      this.notifications.error(`${fn.name} failed`, String(error));
    } finally {
      this.running.set(null);
    }
  }

  /** Run a sequence function and store its masks. Returns whether it
   *  completed. */
  async runOnSequence(
    fn: PythonFunction,
    scope: SequenceRunScope,
  ): Promise<boolean> {
    const frameIds = this.targetFrameIds(scope);
    if (!frameIds.length || this.running()) return false;

    this.running.set(fn.name);
    this.progress.set(null);
    try {
      // The result is merged with what is stored.
      await this.io.saveIfDirty();

      const report = await this.inference.track(() =>
        api.pythonSegmentSequence(
          fn.name,
          frameIds,
          this.sequenceService.currentFrame()?.id ?? null,
          this.context(fn),
        ),
      );

      const unknown = this.unknownDetail(report.unknownLabels);
      const count = report.applied.length;
      if (!count) {
        this.notifications.warn(
          `${fn.name}: nothing applied`,
          unknown ?? 'The function returned no masks.',
        );
        return true;
      }

      // Refresh what derives from the frames (navigator, 3D volume), then the
      // canvas.
      this.propagation.propagated$.next(report.applied);
      this.io.requestReloadEvent();

      const frames = `${count} frame${count === 1 ? '' : 's'}`;
      this.notifications.notify({
        severity: unknown ? 'warn' : 'success',
        summary: `${fn.name} applied`,
        detail: unknown ? `Wrote ${frames}. ${unknown}` : `Wrote ${frames}.`,
        life: 5000,
      });
      return true;
    } catch (error) {
      this.notifications.error(`${fn.name} failed`, String(error));
      return false;
    } finally {
      this.running.set(null);
      this.progress.set(null);
    }
  }

  private unknownDetail(unknown: string[]): string | null {
    if (!unknown.length) return null;
    return `Ignored labels this project does not have: ${unknown.join(', ')}.`;
  }
}
