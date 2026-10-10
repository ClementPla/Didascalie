import {
  ChangeDetectorRef,
  Component,
  OnInit,
  computed,
  inject,
  model,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { open } from '@tauri-apps/plugin-dialog';

import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { DividerModule } from 'primeng/divider';
import { SelectModule } from 'primeng/select';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputTextModule } from 'primeng/inputtext';

import {
  ProjectService,
  RecentProject,
} from '../../../services/project/project.service';
import { api, DatasetFormat, ImportResult } from '../../../lib/api';

/**
 * Import annotations into a project. The target project is opened first,
 * since import writes into the open project, matching frames by filename.
 * The formats and their options come from the backend registry.
 */
@Component({
  selector: 'app-import-dialog',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DialogModule,
    DividerModule,
    SelectModule,
    ToggleSwitchModule,
    InputTextModule,
  ],
  templateUrl: './import-dialog.component.html',
})
export class ImportDialogComponent implements OnInit {
  readonly visible = model(false);

  private readonly project = inject(ProjectService);
  private readonly router = inject(Router);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly recentProjects = signal<RecentProject[]>([]);
  private readonly formats = signal<DatasetFormat[]>([]);
  readonly importFormats = computed(() => this.formats().filter((f) => f.canImport));

  readonly selectedFormat = signal<DatasetFormat | null>(null);
  importOptionValues: Record<string, any> = {};

  targetPath = '';
  sourcePath = '';

  isImporting = false;
  error: string | null = null;
  result: ImportResult | null = null;

  async ngOnInit(): Promise<void> {
    this.recentProjects.set(this.project.getRecentProjects());
    try {
      const formats = await api.listDatasetFormats();
      this.formats.set(formats);
      const first = formats.find((f) => f.canImport);
      if (first) this.selectFormat(first);
    } catch (error) {
      console.error('Failed to list dataset formats:', error);
    }
  }

  selectFormat(format: DatasetFormat): void {
    this.selectedFormat.set(format);
    this.importOptionValues = {};
    for (const opt of format.importOptions) this.importOptionValues[opt.key] = opt.default;
    this.result = null;
  }

  async browseTarget(): Promise<void> {
    const path = await open({
      filters: [{ name: 'Didascalie Project', extensions: ['dida', 'labelmed'] }],
    });
    if (typeof path === 'string') this.targetPath = path;
  }

  async chooseSource(directory: boolean): Promise<void> {
    const selected = await open({
      title: directory ? 'Select annotation folder' : 'Select annotation file',
      directory,
      multiple: false,
    });
    if (typeof selected === 'string') this.sourcePath = selected;
  }

  get canImport(): boolean {
    return (
      !this.isImporting && !!this.selectedFormat() && !!this.targetPath && !!this.sourcePath
    );
  }

  async runImport(): Promise<void> {
    const format = this.selectedFormat();
    if (!format || !this.targetPath || !this.sourcePath) return;

    this.isImporting = true;
    this.error = null;
    this.result = null;
    try {
      await this.project.open(this.targetPath);
      this.result = await api.importDataset(
        format.id,
        this.sourcePath,
        this.importOptionValues,
      );
      // Reopen, for the labels the import created.
      await this.project.open(this.targetPath);
      this.visible.set(false);
      this.router.navigate(['/gallery']);
    } catch (error) {
      this.error = `Import failed: ${error}`;
      console.error('Import failed:', error);
    } finally {
      this.isImporting = false;
      this.cdr.detectChanges();
    }
  }
}
