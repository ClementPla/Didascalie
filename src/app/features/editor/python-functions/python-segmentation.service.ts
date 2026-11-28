import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { listen } from '@tauri-apps/api/event';

import {
  api,
  PythonFunction,
  PythonFunctionParam,
  PythonSegContext,
} from '../../../lib/api';
import { InferenceClientService } from '../../../services/inference-client.service';
import { IOService } from '../../../services/io.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { PropagationService } from '../../../services/labels/propagation.service';
import { NotificationService } from '../../../services/notification.service';
import { ProjectService } from '../../../services/project/project.service';
import { SequenceService } from '../../../services/sequence.service';
import { EditorService } from '../services/editor.service';
import { ImageAdjustmentService } from '../drawable-canvas/service/image-adjustment/image-adjustment.service';
import { CanvasManagerService } from '../drawable-canvas/service/canvas-manager.service';
import { OrchestratorService } from '../drawable-canvas/service/orchestrator.service';
import { UndoRedoService } from '../drawable-canvas/service/undo-redo.service';
import { SequenceUndoService } from '../services/sequence-undo.service';
import { base64ToUint8 } from '../../../core/misc/base64';
import { decodeRle8 } from '../../../lib/rle8';

/** Long enough to read a message from a function, such as a file path. */
const MESSAGE_LIFE = 10000;

/** Which frames a sequence function is given. */
export type SequenceRunScope = 'all' | 'fromCurrent';

/** What an argument holds; `null` is a number field left empty. */
export type PythonArgValue = number | boolean | string | null;

export interface SequenceRunProgress {
  stage: 'reading' | 'sending' | 'running' | 'receiving';
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
  private readonly sequenceUndo = inject(SequenceUndoService);
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
  private readonly adjustments = inject(ImageAdjustmentService);
  private readonly editor = inject(EditorService);

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

  /** Values the user changed, by function then argument. Kept for the session,
   *  so they survive the Python script being restarted. */
  private readonly argValues = signal<
    Record<string, Record<string, PythonArgValue>>
  >({});

  /** Whether every function receives the image with the image adjustments
   *  applied. Off by default: a display setting should not change a result
   *  unasked. */
  readonly useAdjustments = signal(false);

  /** Whether a microscopy frame the project holds at a lower resolution
   *  level is read again from its file at full resolution. On by default: a
   *  function is not limited to what the editor can hold. */
  readonly fullResolution = signal(true);

  /** The editor's own switch for the image adjustments (Q). */
  get adjustmentsEnabled(): boolean {
    return this.editor.useProcessing;
  }

  /** What the backend applies to each frame: red, green, then blue. Null
   *  when the frame goes as it is. */
  private imageLut(): number[] | null {
    if (!this.useAdjustments()) return null;
    const lut = this.adjustments.activeLUT();
    return lut ? [...lut.r, ...lut.g, ...lut.b] : null;
  }

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

  /** The value to show: the user's, unless the function's declaration has
   *  since changed so that it no longer fits. */
  argValue(fn: PythonFunction, param: PythonFunctionParam): PythonArgValue {
    const stored = this.argValues()[fn.name]?.[param.name];
    return stored !== undefined && fitsType(param, stored)
      ? stored
      : param.default;
  }

  setArg(
    fn: PythonFunction,
    param: PythonFunctionParam,
    value: PythonArgValue,
  ): void {
    this.argValues.update((all) => ({
      ...all,
      [fn.name]: { ...all[fn.name], [param.name]: value },
    }));
  }

  /** Why the current value cannot be sent, or null. */
  argError(fn: PythonFunction, param: PythonFunctionParam): string | null {
    if (param.type !== 'int' && param.type !== 'float') return null;
    const value = this.argValue(fn, param) as number | null;
    if (value === null) return 'A value is required.';
    if (param.type === 'int' && !Number.isInteger(value)) {
      return 'Must be a whole number.';
    }
    if (param.min !== null && value < param.min) {
      return `Must be at least ${param.min}.`;
    }
    if (param.max !== null && value > param.max) {
      return `Must be at most ${param.max}.`;
    }
    return null;
  }

  argsValid(fn: PythonFunction): boolean {
    return fn.params.every((p) => this.argError(fn, p) === null);
  }

  private args(fn: PythonFunction): PythonSegContext['args'] {
    return Object.fromEntries(
      fn.params.map((p) => [p.name, this.argValue(fn, p) as number]),
    );
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
      args: this.args(fn),
      imageLut: this.imageLut(),
      fullResolution: this.fullResolution(),
    };
  }

  async runOnFrame(fn: PythonFunction): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!frame || this.running() || !this.argsValid(fn)) return;

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
          mask: decodeRle8(base64ToUint8(layer.rle8Base64), frame.width * frame.height),
        }))
        .filter((layer) => layer.index >= 0);

      this.resolutionWarning(fn, result.resolutionNote);

      if (!applied.length && result.message) {
        this.showMessage(fn, result.message, result.unknownLabels);
        return;
      }

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
      const note = result.message ? `${result.message} ` : '';
      this.notifications.notify({
        severity: unknown ? 'warn' : 'success',
        summary: `${fn.name} applied`,
        detail: unknown
          ? `${note}${unknown} Ctrl+Z to revert.`
          : `${note}Ctrl+Z to revert`,
        life: result.message ? MESSAGE_LIFE : unknown ? 6000 : 3000,
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
    if (!frameIds.length || this.running() || !this.argsValid(fn)) return false;

    this.running.set(fn.name);
    this.progress.set(null);
    try {
      // The result is merged with what is stored (`record` saves first).
      const report = await this.sequenceUndo.record(fn.name, frameIds, () =>
        this.inference.track(() =>
          api.pythonSegmentSequence(
            fn.name,
            frameIds,
            this.sequenceService.currentFrame()?.id ?? null,
            this.context(fn),
          ),
        ),
      );

      this.resolutionWarning(fn, report.resolutionNote);
      const unknown = this.unknownDetail(report.unknownLabels);
      const count = report.applied.length;
      if (!count && report.message) {
        this.showMessage(fn, report.message, report.unknownLabels);
        return true;
      }
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
        detail: [`Wrote ${frames}.`, report.message, unknown]
          .filter(Boolean)
          .join(' '),
        life: report.message ? MESSAGE_LIFE : 5000,
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

  /** A run that changed no mask but has something to say. */
  private showMessage(
    fn: PythonFunction,
    message: string,
    unknownLabels: string[],
  ): void {
    const unknown = this.unknownDetail(unknownLabels);
    this.notifications.notify({
      severity: unknown ? 'warn' : 'success',
      summary: fn.name,
      detail: unknown ? `${message} ${unknown}` : message,
      life: MESSAGE_LIFE,
    });
  }

  /** The frames did not all go at full resolution. */
  private resolutionWarning(fn: PythonFunction, note: string | null): void {
    if (note) this.notifications.warn(`${fn.name}: not at full resolution`, note);
  }

  private unknownDetail(unknown: string[]): string | null {
    if (!unknown.length) return null;
    return `Ignored labels this project does not have: ${unknown.join(', ')}.`;
  }
}

function fitsType(param: PythonFunctionParam, value: PythonArgValue): boolean {
  switch (param.type) {
    case 'int':
    case 'float':
      return value === null || typeof value === 'number';
    case 'bool':
      return typeof value === 'boolean';
    case 'enum':
      return param.choices.includes(value as string);
  }
}
