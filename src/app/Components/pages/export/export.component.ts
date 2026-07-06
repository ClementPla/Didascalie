import { ChangeDetectorRef, Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PanelModule } from 'primeng/panel';
import { DividerModule } from 'primeng/divider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { SelectButtonModule } from 'primeng/selectbutton';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';

import { ProjectService } from '../../../Services/ProjectService/project.service';
import { api, DatasetFormat } from '../../../lib/api';

interface Progress {
  current: number;
  total: number;
  currentFile: string;
}

/**
 * Schema-driven export: the format list and every format's options come from the
 * backend registry, so new formats appear here with no UI changes. Import lives
 * separately on the opening page (launcher).
 */
@Component({
  selector: 'app-export',
  imports: [
    CommonModule,
    FormsModule,
    PanelModule,
    DividerModule,
    ToggleSwitchModule,
    InputTextModule,
    ButtonModule,
    SelectModule,
    SelectButtonModule,
  ],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class ExportComponent implements OnInit, OnDestroy {
  private readonly formats = signal<DatasetFormat[]>([]);
  readonly exportFormats = computed(() => this.formats().filter((f) => f.canExport));

  // Export state.
  readonly selectedFormat = signal<DatasetFormat | null>(null);
  exportOptionValues: Record<string, any> = {};
  onlyReviewed = true;
  totalFiles = 0;
  filesExported = 0;
  isExporting = false;
  exportError: string | null = null;
  currentFile = '';

  readonly reviewedOptions = [
    { label: 'All frames', value: false },
    { label: 'Reviewed only', value: true },
  ];

  private unlisten: UnlistenFn | null = null;

  constructor(
    public projectService: ProjectService,
    private cdr: ChangeDetectorRef,
  ) {}

  async ngOnInit(): Promise<void> {
    this.unlisten = await listen<Progress>('export-progress', (event) => {
      this.filesExported = event.payload.current;
      this.totalFiles = event.payload.total;
      this.currentFile = event.payload.currentFile;
      this.cdr.detectChanges();
    });

    try {
      const formats = await api.listDatasetFormats();
      this.formats.set(formats);
      const firstExport = formats.find((f) => f.canExport);
      if (firstExport) this.selectFormat(firstExport);
    } catch (error) {
      console.error('Failed to list dataset formats:', error);
    }
  }

  ngOnDestroy(): void {
    this.unlisten?.();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  selectFormat(format: DatasetFormat): void {
    this.selectedFormat.set(format);
    this.exportOptionValues = {};
    for (const opt of format.exportOptions) this.exportOptionValues[opt.key] = opt.default;
  }

  async export(): Promise<void> {
    const format = this.selectedFormat();
    if (!format) return;

    const outputFolder = await save({
      title: 'Select export folder',
      defaultPath: `${this.projectName}_${format.id}`,
    });
    if (!outputFolder) return;

    this.filesExported = 0;
    this.totalFiles = 0;
    this.isExporting = true;
    this.exportError = null;

    try {
      const result = await api.exportDataset(
        format.id,
        outputFolder,
        this.onlyReviewed,
        this.exportOptionValues,
      );
      if (result.errors.length > 0) {
        this.exportError = `Exported with ${result.errors.length} error(s) — see console.`;
        console.error('Export errors:', result.errors);
      }
    } catch (error) {
      this.exportError = `Export failed: ${error}`;
      console.error('Export failed:', error);
    } finally {
      this.isExporting = false;
      this.cdr.detectChanges();
    }
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  get projectName(): string {
    return this.projectService.config().name || 'project';
  }

  get canExport(): boolean {
    return this.projectService.isOpen() && !this.isExporting && !!this.selectedFormat();
  }

  get exportProgress(): number {
    if (this.totalFiles === 0) return 0;
    return Math.round((this.filesExported / this.totalFiles) * 100);
  }
}
