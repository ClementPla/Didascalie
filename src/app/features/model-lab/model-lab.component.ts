import { Component, NgZone, OnDestroy, OnInit, computed, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { ProgressBarModule } from 'primeng/progressbar';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import {
  api,
  DatasetSummary,
  EncoderStatus,
  MlProgress,
  TrainSummary,
  LabelId,
  StorageUsage,
  TrainTick,
} from '../../lib/api';

@Component({
  selector: 'app-model-lab',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CardModule,
    ProgressBarModule,
    TableModule,
    TagModule,
    ToastModule,
  ],
  providers: [MessageService],
  templateUrl: './model-lab.component.html',
  styleUrl: './model-lab.component.scss',
})
export class ModelLabComponent implements OnInit, OnDestroy {
  private messages = inject(MessageService);
  private zone = inject(NgZone);

  readonly encoders = signal<EncoderStatus[]>([]);
  readonly summary = signal<DatasetSummary | null>(null);

  /** `null`: the local feature basis only. */
  readonly selectedEncoder = signal<string | null>(null);
  readonly running = signal(false);
  readonly downloading = signal<string | null>(null);
  readonly progress = signal<MlProgress | null>(null);
  readonly tick = signal<TrainTick | null>(null);
  readonly error = signal<string | null>(null);

  readonly job = signal<'train' | null>(null);
  /** Stop was requested. The fit finishes its current epoch first. */
  readonly stopping = signal(false);
  /** Persist encoder features to app data between runs. On unless turned off. */
  cacheFeatures = (localStorage.getItem('dida.ml.cacheFeatures') ?? '1') === '1';
  readonly storage = signal<StorageUsage | null>(null);
  /** Labels the head will predict. Empty = every label in the project. */
  readonly labels = signal<LabelId[]>([]);
  readonly selectedLabels = signal<Set<number>>(new Set());
  readonly model = signal<TrainSummary | null>(null);
  /** Rolling loss history for the current fit, for a sparkline. */
  readonly lossHistory = signal<number[]>([]);

  workingSize = 384;
  patchesPerFrame = 24;
  epochs = 40;

  private unlisten: UnlistenFn[] = [];

  async ngOnInit(): Promise<void> {
    // Tauri event callbacks fire outside Angular's zone.
    this.unlisten.push(
      await listen<MlProgress>('ml-progress', (e) =>
        this.zone.run(() => {
          console.log('[ml-progress]', e.payload);
          this.progress.set(e.payload);
        }),
      ),
      await listen<TrainTick>('ml-train-progress', (e) =>
        this.zone.run(() => {
          console.log('[ml-train-progress]', e.payload);
          const t = e.payload;
          this.tick.set(t);
          // A new fit starts a new trace.
          this.lossHistory.update((h) =>
            t.epoch <= 1 ? [t.loss] : [...h.slice(-199), t.loss],
          );
        }),
      ),
    );
    await this.refresh();
  }

  ngOnDestroy(): void {
    this.unlisten.forEach((u) => u());
  }

  async refresh(): Promise<void> {
    try {
      const [encoders, summary] = await Promise.all([
        api.mlListEncoders(),
        api.mlDatasetSummary(),
      ]);
      this.encoders.set(encoders);
      this.summary.set(summary);
      this.model.set(await api.mlModelStatus());
      const labels = await api.listLabels();
      this.labels.set(labels);
      // Every label by default.
      if (!this.selectedLabels().size) {
        this.selectedLabels.set(new Set(labels.map((l) => l.id)));
      }
      await this.refreshStorage();
    } catch (e) {
      this.error.set(String(e));
    }
  }

  /** Too few reviewed frames to hold any out. */
  readonly canRun = computed(() => {
    const s = this.summary();
    return !!s && s.annotatedFrames >= 2 && s.labels > 0 && !this.running();
  });

  readonly blockedReason = computed(() => {
    const s = this.summary();
    if (!s) return 'Loading project…';
    if (s.labels === 0) return 'This project defines no segmentation labels.';
    if (s.annotatedFrames < 2) {
      // Say why there are too few: annotated frames that are not reviewed.
      if (s.unreviewedFrames > 0)
        return `Only ${s.annotatedFrames} reviewed frame(s). ${s.unreviewedFrames} more are annotated but not reviewed — mark them reviewed in the editor to train on them. At least 2 are needed so one can be held out.`;
      return `Only ${s.annotatedFrames} reviewed frame(s). At least 2 are needed so one can be held out.`;
    }
    return null;
  });

  async download(enc: EncoderStatus): Promise<void> {
    this.downloading.set(enc.id);
    try {
      await api.mlDownloadEncoder(enc.id);
      await this.refresh();
      this.messages.add({
        severity: 'success',
        summary: 'Encoder ready',
        detail: enc.name,
      });
    } catch (e) {
      this.messages.add({
        severity: 'error',
        summary: 'Download failed',
        detail: String(e),
      });
    } finally {
      this.downloading.set(null);
    }
  }

  selectEncoder(id: string | null): void {
    this.selectedEncoder.set(id);
  }

  private options() {
    return {
      encoderId: this.selectedEncoder(),
      workingSize: this.workingSize,
      patchesPerFrame: this.patchesPerFrame,
      cacheFeatures: this.persistCacheChoice(),
      labelIds: [...this.selectedLabels()],
      epochs: this.epochs,
    };
  }

  private begin(job: 'train'): void {
    this.running.set(true);
    this.job.set(job);
    this.error.set(null);
    this.progress.set(null);
    this.tick.set(null);
    this.lossHistory.set([]);
    this.stopping.set(false);
  }

  private end(): void {
    this.running.set(false);
    this.job.set(null);
    this.progress.set(null);
    this.tick.set(null);
    this.stopping.set(false);
  }

  fmtBytes(n: number): string {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(0)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
  }

  /** Remember the choice across restarts. */
  private persistCacheChoice(): boolean {
    localStorage.setItem('dida.ml.cacheFeatures', this.cacheFeatures ? '1' : '0');
    return this.cacheFeatures;
  }

  toggleLabel(id: number): void {
    const next = new Set(this.selectedLabels());
    if (!next.delete(id)) next.add(id);
    this.selectedLabels.set(next);
  }

  async refreshStorage(): Promise<void> {
    try {
      this.storage.set(await api.mlStorageUsage());
    } catch {
      this.storage.set(null);
    }
  }

  async clearCache(): Promise<void> {
    try {
      const n = await api.mlClearFeatureCache();
      this.messages.add({
        severity: 'success',
        summary: 'Cache cleared',
        detail: `${n} cached feature file${n === 1 ? '' : 's'} removed`,
      });
      await this.refreshStorage();
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async stop(): Promise<void> {
    this.stopping.set(true);
    try {
      await api.mlStopTraining();
    } catch (e) {
      this.error.set(String(e));
      this.stopping.set(false);
    }
  }

  /** Discard the trained model from the project and this session. */
  async forget(): Promise<void> {
    try {
      await api.mlForgetModel();
      this.model.set(null);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async trainModel(): Promise<void> {
    this.begin('train');
    try {
      const summary = await api.mlTrainModel(this.options());
      this.model.set(summary);
      this.messages.add({
        severity: 'success',
        summary: 'Model ready',
        detail: `Dice ${summary.metrics.meanDice.toFixed(3)} on ${summary.valFrames} held-out frames`,
      });
    } catch (e) {
      this.error.set(String(e));
    } finally {
      this.end();
    }
  }

  /** Overall completion, from whichever phase is live: feature extraction and
   *  training are reported by different events. */
  readonly progressPercent = computed(() => {
    const t = this.tick();
    if (t) {
      const perFit = t.epochs > 0 ? t.epoch / t.epochs : 0;
      if (t.points > 0) {
        return Math.round(((t.point + perFit) / t.points) * 100);
      }
      return Math.round(perFit * 100);
    }
    const p = this.progress();
    if (!p || p.total === 0) return 0;
    return Math.round((p.done / p.total) * 100);
  });

  readonly progressLabel = computed(() => {
    const t = this.tick();
    if (t) {
      const fit =
        t.points > 1 ? `fit ${t.point + 1}/${t.points} · ${t.budget} frames · ` : '';
      return `Training — ${fit}epoch ${t.epoch}/${t.epochs} · loss ${t.loss.toFixed(4)} · ${Math.round(t.epochMs)} ms/epoch`;
    }
    const p = this.progress();
    if (p) {
      return `Extracting features — frame ${p.done}/${p.total} · ${Math.round(p.lastMs)} ms/frame`;
    }
    return this.job() === 'train' ? 'Preparing…' : 'Starting…';
  });

  readonly etaLabel = computed(() => {
    const ms = this.tick()?.etaMs ?? this.progress()?.etaMs ?? 0;
    if (ms <= 0) return null;
    const s = Math.round(ms / 1000);
    if (s < 60) return `~${s}s left`;
    const m = Math.floor(s / 60);
    return m < 60 ? `~${m}m ${s % 60}s left` : `~${Math.floor(m / 60)}h ${m % 60}m left`;
  });

  readonly deviceLabel = computed(() => {
    const t = this.tick();
    if (!t) return null;
    return `${t.device} · ${t.samples.toLocaleString()} samples × ${t.features} features`;
  });

  readonly lossPath = computed(() => {
    const h = this.lossHistory();
    if (h.length < 2) return null;
    const w = 240;
    const ht = 34;
    const max = Math.max(...h);
    const min = Math.min(...h);
    const span = max - min || 1;
    return h
      .map((v, i) => {
        const x = (i / (h.length - 1)) * w;
        const y = ht - ((v - min) / span) * ht;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  });

  fmt(v: number): string {
    return v.toFixed(3);
  }
}
