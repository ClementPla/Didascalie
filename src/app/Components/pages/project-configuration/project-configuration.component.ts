import { AfterViewInit, Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

// PrimeNG
import { CardModule } from 'primeng/card';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { FloatLabelModule } from 'primeng/floatlabel';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { CheckboxModule } from 'primeng/checkbox';
import { FieldsetModule } from 'primeng/fieldset';
import { DividerModule } from 'primeng/divider';
import { PanelModule } from 'primeng/panel';
import { ProgressBarModule } from 'primeng/progressbar';
import { ToastModule } from 'primeng/toast';
import { TableModule } from 'primeng/table';
import { MessageService } from 'primeng/api';
import { LabelledSwitchComponent } from '../../../generics/labelled-switch/labelled-switch.component';
// Tauri
import { open, save } from '@tauri-apps/plugin-dialog';

// Services
import { ProjectService, RecentProject } from '../../../Services/ProjectService/project.service';
import { LabelsService } from '../../../Services/Labels/labels.service';

// Components
import { ClassificationConfigurationComponent } from './classification-configuration/classification-configuration.component';
import { PixelsConfigurationComponent } from './pixels-configuration/pixels-configuration.component';
import { UIStateService } from '../../../Services/uistate.service';
import { SequenceService } from '../../../Services/sequence.service';

@Component({
  selector: 'app-project-configuration',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    LabelledSwitchComponent,
    CardModule,
    ButtonModule,
    InputTextModule,
    FloatLabelModule,
    ToggleSwitchModule,
    CheckboxModule,
    FieldsetModule,
    DividerModule,
    PanelModule,
    ProgressBarModule,
    ToastModule,
    TableModule,
    ClassificationConfigurationComponent,
    PixelsConfigurationComponent,
  ],
  providers: [MessageService],
  templateUrl: './project-configuration.component.html',
  styleUrl: './project-configuration.component.scss',
})
export class ProjectConfigurationComponent implements AfterViewInit {
  // Validation state
  readonly isNameValid = signal(true);
  readonly isInputValid = signal(true);
  readonly isLoading = signal(false);

  // Recent projects
  recentProjects: RecentProject[] = [];

  constructor(
    public projectService: ProjectService,
    public labelService: LabelsService,
    private messageService: MessageService,
    private router: Router,
    private uiStateService: UIStateService,
    private sequenceService: SequenceService,
  ) {
    this.recentProjects = this.projectService.getRecentProjects();
  }

  // ==========================================
  // Folder Selection
  // ==========================================

  async selectInputFolder(): Promise<void> {
    const folder = await open({ directory: true });
    if (folder) {
      this.projectService.setInputFolder(folder as string);
      this.isInputValid.set(true);
    }
  }

  async ngAfterViewInit(): Promise<void> {
    // For debugging
    // await this.loadProjectFile('c:/Users/cleme/Documents/data/multiImageTest/125/C.labelmed')
    // console.log('Loaded test project');
    // await this.sequenceService.loadSequences();
    // await this.sequenceService.selectSequence(this.sequenceService.sequences()[1]);
    // this.uiStateService.navigateToEditor();
  }
  // ==========================================
  // Config Bindings (two-way via signals)
  // ==========================================

  get projectName(): string {
    return this.projectService.projectName();
  }
  set projectName(value: string) {
    this.projectService.setName(value);
    this.isNameValid.set(!!value);
  }

  get inputFolder(): string {
    return this.projectService.inputFolder() ?? '';
  }
  set inputFolder(value: string) {
    this.projectService.setInputFolder(value);
    this.isInputValid.set(!!value);
  }

  get inputRegex(): string {
    return this.projectService.inputRegex();
  }
  set inputRegex(value: string) {
    this.projectService.setInputRegex(value);
  }

  get recursive(): boolean {
    return this.projectService.recursive();
  }
  set recursive(value: boolean) {
    this.projectService.setRecursive(value);
  }

  get foldersAsSequences(): boolean {
    return this.projectService.foldersAsSequences();
  }

  set foldersAsSequences(value: boolean) {
    this.projectService.setFoldersAsSequences(value);
  }


  get imagesEmbedded(): boolean {
    return this.projectService.imagesEmbedded();
  }
  set imagesEmbedded(value: boolean) {
    this.projectService.setImagesEmbedded(value);
  }

  get segmentationEnabled(): boolean {
    return this.projectService.isSegmentation();
  }
  set segmentationEnabled(value: boolean) {
    this.projectService.setSegmentationEnabled(value);
  }

  get classificationEnabled(): boolean {
    return this.projectService.isClassification();
  }
  set classificationEnabled(value: boolean) {
    this.projectService.setClassificationEnabled(value);
  }

  get instanceSegmentationEnabled(): boolean {
    return this.projectService.isInstanceSegmentation();
  }
  set instanceSegmentationEnabled(value: boolean) {
    this.projectService.setInstanceSegmentationEnabled(value);
  }

  // ==========================================
  // Project Actions
  // ==========================================

  async startProject(): Promise<void> {
    // Validate
    const config = this.projectService.config();
    this.isNameValid.set(!!config.name);
    this.isInputValid.set(!!config.input_folder);

    if (!this.projectService.isConfigValid()) {
      return;
    }

    this.isLoading.set(true);

    try {
      // Ask user where to save the project file
      const projectPath = await save({
        defaultPath: `${config.name}.labelmed`,
        filters: [{ name: 'LabelMed Project', extensions: ['labelmed'] }],
      });

      if (!projectPath) {
        this.isLoading.set(false);
        return;
      }

      // Create project
      await this.projectService.create(projectPath);

      // Scan folder and import images
      const result = await this.projectService.scanFolder();

      this.messageService.add({
        severity: 'success',
        summary: 'Project Created',
        detail: `Imported ${result.frames_created} images in ${result.sequences_created} sequences`,
      });
      console.log('Scan result:', result);
      // Navigate to editor
      this.router.navigate(['/gallery']);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: String(error),
      });
    } finally {
      this.isLoading.set(false);
    }
  }

  async openRecentProject(project: RecentProject): Promise<void> {
    this.isLoading.set(true);

    try {
      await this.projectService.open(project.path);
      this.router.navigate(['/gallery']);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Error opening project',
        detail: String(error),
      });
      // Remove from recent if it failed (file might not exist)
      this.projectService.removeFromRecentProjects(project.path);
      this.recentProjects = this.projectService.getRecentProjects();
    } finally {
      this.isLoading.set(false);
    }
  }

  async openProjectFile(): Promise<void> {
    const path = await open({
      filters: [{ name: 'LabelMed Project', extensions: ['labelmed'] }],
    });

    if (path) {
      this.isLoading.set(true);
      try {
        await this.projectService.open(path as string);
        this.router.navigate(['/gallery']);
      } catch (error) {
        this.messageService.add({
          severity: 'error',
          summary: 'Error',
          detail: String(error),
        });
      } finally {
        this.isLoading.set(false);
      }
    }
  }

  async loadProjectFile(path: string): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.projectService.open(path);
      this.router.navigate(['/gallery']);
    } catch (error) {
      console.error('Error loading project file:', error);
      this.messageService.add({
        severity: 'error',
        summary: 'Error',
        detail: String(error),
      });
    } finally {
      this.isLoading.set(false);
    }
  }

  removeRecentProject(project: RecentProject): void {
    this.projectService.removeFromRecentProjects(project.path);
    this.recentProjects = this.projectService.getRecentProjects();
  }

  // ==========================================
  // Reset
  // ==========================================

  resetProject(): void {
    this.projectService.reset();
    this.isNameValid.set(true);
    this.isInputValid.set(true);
  }
}