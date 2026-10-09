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

/** Which frames a sequence function is given. */
export type SequenceRunScope = 'all' | 'fromCurrent';

export interface SequenceRunProgress {
  stage: 'sending' | 'running' | 'receiving';
  done: number;
  total: number;
}

/**
 * Runs the user's Python segmentation functions from the editor.
 *
 * The two kinds land differently on purpose. A frame function's masks are
 * applied to the canvas as one undo step — run, look, Ctrl+Z, tweak the Python,
 * run again. A sequence function writes frames that are not open, so it goes
 * straight to the project behind a confirmation, as propagation does.
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

  /** Whether there is anything to show: no functions, no UI at all. */
  readonly available = computed(
    () =>
      this.frameFunctions().length > 0 || this.sequenceFunctions().length > 0,
  );

  /** Name of the function in flight. One at a time: the Python server is
   *  single-threaded, and two results racing onto one canvas help nobody. */
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

  /** Value a stroke would write on the active label (see DrawService). */
  private activeValue(): number {
    if (!this.projectService.isInstanceSegmentation()) return 1;
    const instance = this.labelService.activeSegInstance?.instance ?? 1;
    return Math.min(255, Math.max(1, Math.round(instance)));
  }

  private context(fn: PythonFunction): PythonSegContext {
    return {
      labels: this.labelService.listSegmentationLabels.map((l) => ({
        id: l.id,
        name: l.label,
        isInstance: l.shades !== null,
      })),
      activeLabelId: this.labelService.activeLabel?.id ?? null,
      activeValue: this.activeValue(),
      sendMasks: fn.wants.includes('masks'),
    };
  }

  /** Run a frame function on the open frame and apply what it returns. */
  async runOnFrame(fn: PythonFunction): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame || this.running()) return;

    this.running.set(fn.name);
    try {
      const context = this.context(fn);
      // The backend sends what is *stored*; without this the function would be
      // prompted with the last autosave rather than what is on screen.
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

      // Snapshot before mutating so the whole run is one undo step.
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

  /**
   * Run a sequence function and store its masks. Returns whether it completed,
   * so the confirmation dialog knows to close.
   */
  async runOnSequence(
    fn: PythonFunction,
    scope: SequenceRunScope,
  ): Promise<boolean> {
    const frameIds = this.targetFrameIds(scope);
    if (!frameIds.length || this.running()) return false;

    this.running.set(fn.name);
    this.progress.set(null);
    try {
      // Always: the result is merged with what is stored, and the open frame
      // is reloaded from the project afterwards.
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

      // Frames changed underneath the UI: refresh what derives from them
      // (navigator statuses, the 3D volume), then the canvas itself.
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

/** Decode a base64 mask into the flat uint8 buffer the canvas manager holds. */
function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
