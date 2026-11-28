import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { PanelModule } from 'primeng/panel';
import { ProgressBarModule } from 'primeng/progressbar';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import { PythonFunction } from '../../../lib/api';
import { PythonParamsComponent } from './python-params.component';
import { InferenceClientService } from '../../../services/inference-client.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { SequenceService } from '../../../services/sequence.service';
import {
  PythonSegmentationService,
  SequenceRunScope,
} from './python-segmentation.service';

/** The Python segmentation functions, one row each with its run button. */
@Component({
  selector: 'app-python-functions',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    DialogModule,
    PanelModule,
    ProgressBarModule,
    SelectButtonModule,
    ToggleSwitchModule,
    TooltipModule,
    PythonParamsComponent,
  ],
  templateUrl: './python-functions.component.html',
  styleUrl: './python-functions.component.scss',
})
export class PythonFunctionsComponent {
  readonly python = inject(PythonSegmentationService);
  private readonly inference = inject(InferenceClientService);
  private readonly sequenceService = inject(SequenceService);
  private readonly labels = inject(LabelsService);

  readonly endpoint = computed(() => {
    const { host, port } = this.inference.endpoint();
    return `${host}:${port}`;
  });

  /** The sequence function awaiting confirmation. */
  readonly pending = signal<PythonFunction | null>(null);
  readonly scope = signal<SequenceRunScope>('all');

  readonly scopeOptions = [
    { label: 'Whole sequence', value: 'all' as const },
    { label: 'From this frame', value: 'fromCurrent' as const },
  ];

  /** Functions whose arguments are folded away. Shown by default, since they
   *  decide what a click on Run does. */
  readonly collapsed = signal<ReadonlySet<string>>(new Set());

  toggleParams(fn: PythonFunction): void {
    this.collapsed.update((names) => {
      const next = new Set(names);
      if (!next.delete(fn.name)) next.add(fn.name);
      return next;
    });
  }

  readonly targetCount = computed(
    () => this.python.targetFrameIds(this.scope()).length,
  );

  readonly sequenceName = computed(
    () => this.sequenceService.currentSequence()?.name ?? '',
  );

  readonly progressText = computed(() => {
    const p = this.python.progress();
    if (!p) return 'Starting…';
    switch (p.stage) {
      case 'reading':
        return 'Reading the frames at full resolution…';
      case 'sending':
        return `Sending frames to Python (${p.done + 1}/${p.total})`;
      case 'running':
        return 'Python is running the function…';
      case 'receiving':
        return `Storing masks (${p.done + 1}/${p.total})`;
    }
  });

  /** Percent done, or null while Python computes. */
  readonly progressValue = computed(() => {
    const p = this.python.progress();
    if (!p || p.stage === 'running' || p.stage === 'reading' || !p.total) {
      return null;
    }
    return Math.round((100 * (p.done + 1)) / p.total);
  });

  frameTooltip(fn: PythonFunction): string {
    if (!this.python.argsValid(fn)) return 'Fix the arguments first.';
    const prompt = fn.wants.includes('masks')
      ? ' It reads what is already drawn.'
      : '';
    return `Run ${fn.name} on this frame.${prompt} One Ctrl+Z reverts it.`;
  }

  /** A single returned mask lands on this label. */
  get activeLabelName(): string | null {
    return this.labels.activeLabel?.label ?? null;
  }

  askSequenceRun(fn: PythonFunction): void {
    this.pending.set(fn);
  }

  async confirmSequenceRun(): Promise<void> {
    const fn = this.pending();
    if (!fn) return;
    if (await this.python.runOnSequence(fn, this.scope())) {
      this.pending.set(null);
    }
  }

  pendingArgsValid(): boolean {
    const fn = this.pending();
    return !fn || this.python.argsValid(fn);
  }

  /** Closing only hides the dialog; a run in flight cannot be recalled. */
  closeDialog(): void {
    if (!this.python.running()) this.pending.set(null);
  }
}
