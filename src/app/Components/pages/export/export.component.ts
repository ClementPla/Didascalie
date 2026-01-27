import { ChangeDetectorRef, Component, OnDestroy } from '@angular/core';
import { PanelModule } from 'primeng/panel';
import { DividerModule } from 'primeng/divider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';
import { FloatLabelModule } from 'primeng/floatlabel';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { KnobModule } from 'primeng/knob';
import { RadioButtonModule } from 'primeng/radiobutton';
import { SelectButtonModule } from 'primeng/selectbutton';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';

import { ProjectService } from '../../../Services/ProjectService/project.service';
import { SequenceService } from '../../../Services/sequence.service';
import { LabelsService } from '../../../Services/Labels/labels.service';
import { api, ExportOptions, ExportResult } from '../../../lib/api';

interface ExportProgress {
  current: number;
  total: number;
  currentFile: string;
}

@Component({
  selector: 'app-export',
  imports: [
    PanelModule,
    DividerModule,
    ToggleSwitchModule,
    FormsModule,
    FloatLabelModule,
    InputTextModule,
    ButtonModule,
    KnobModule,
    SelectButtonModule,
    RadioButtonModule,
  ],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class ExportComponent implements OnDestroy {
  // Export options
  exportIndividualMask: boolean = true;
  exportCombinedMask: boolean = true;
  exportColorMap: boolean = true;
  exportOnlyReviewed: boolean = true;
  exportClassifications: boolean = true;

  // Progress tracking
  totalFiles: number = 0;
  filesExported: number = 0;
  isExporting: boolean = false;
  exportError: string | null = null;
  currentFile: string = '';

  // UI options
  exportOptionsDefinedRevisions = [
    { label: 'All', value: false },
    { label: 'Reviewed only', value: true },
  ];

  // Event listeners
  private unlisten: UnlistenFn | null = null;

  constructor(
    public projectService: ProjectService,
    public sequenceService: SequenceService,
    public labelService: LabelsService,
    private cdr: ChangeDetectorRef,
  ) {
    this.setupListeners();
  }

  ngOnDestroy(): void {
    if (this.unlisten) {
      this.unlisten();
    }
  }

  // ==========================================
  // Export
  // ==========================================

  async export(): Promise<void> {
    // Select output folder
    const outputFolder = await save({
      title: 'Select Export Folder',
      defaultPath: `${this.projectName}_export`,
    });

    if (!outputFolder) {
      return; // User cancelled
    }

    this.filesExported = 0;
    this.totalFiles = 0;
    this.isExporting = true;
    this.exportError = null;

    try {
      const options: ExportOptions = {
        output_folder: outputFolder,
        individual_mask: this.exportIndividualMask,
        combined_mask: this.exportCombinedMask,
        colormap: this.exportColorMap,
        only_reviewed: this.exportOnlyReviewed,
        instance_segmentation: this.projectService.isInstanceSegmentation(),
        classifications: this.exportClassifications,
      };

      const result = await api.exportAnnotations(options);

      if (result.errors.length > 0) {
        this.exportError = `Exported ${result.total_exported} files with ${result.errors.length} errors`;
        console.error('Export errors:', result.errors);
      } else {
        console.log(`Export completed: ${result.total_exported} files`);
      }
    } catch (error) {
      console.error('Export failed:', error);
      this.exportError = `Export failed: ${error}`;
    } finally {
      this.isExporting = false;
      this.cdr.detectChanges();
    }
  }

  // ==========================================
  // Event Listeners
  // ==========================================

  private async setupListeners(): Promise<void> {
    this.unlisten = await listen<ExportProgress>('export-progress', (event) => {
      this.filesExported = event.payload.current;
      this.totalFiles = event.payload.total;
      this.currentFile = event.payload.currentFile;
      this.cdr.detectChanges();
    });
  }

  // ==========================================
  // Getters
  // ==========================================

  get projectName(): string {
    return this.projectService.config().name || 'project';
  }

  get canExport(): boolean {
    return this.projectService.isOpen() && !this.isExporting;
  }

  get exportProgress(): number {
    if (this.totalFiles === 0) return 0;
    return Math.round((this.filesExported / this.totalFiles) * 100);
  }

  get hasLabels(): boolean {
    return this.labelService.listSegmentationLabels.length > 0;
  }
}
