import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  OnInit,
} from '@angular/core';
import { DividerModule } from 'primeng/divider';
import { PanelModule } from 'primeng/panel';
import { FloatLabelModule } from 'primeng/floatlabel';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';

import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputTextModule } from 'primeng/inputtext';
import { open } from '@tauri-apps/plugin-dialog';
import { FieldsetModule } from 'primeng/fieldset';
import { ButtonModule } from 'primeng/button';
import { ProjectService } from '../../../Services/ProjectService/project.service';
import { LabelsService } from '../../../Services/Project/labels.service';
import { ColorPickerModule } from 'primeng/colorpicker';
import { CheckboxModule } from 'primeng/checkbox';
import { CLIService } from '../../../Services/cli.service';
import { ClassificationConfigurationComponent } from './classification-configuration/classification-configuration.component';
import { TableModule } from 'primeng/table';
import { path } from '@tauri-apps/api';
import { GenericsModule } from '../../../generics/generics.module';
import { TextConfigurationComponent } from './text-configuration/text-configuration.component';
import { PixelsConfigurationComponent } from './pixels-configuration/pixels-configuration.component';
import { ViewService } from '../../../Services/UI/view.service';
import { EditorService } from '../editor/services/editor.service';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CommonModule } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PostProcessOption } from '../../../Core/tools';
import { ProgressBarModule } from 'primeng/progressbar';

@Component({
  selector: 'app-project-configuration',
  imports: [
    CardModule,
    TableModule,
    CommonModule,
    ClassificationConfigurationComponent,
    DividerModule,
    ColorPickerModule,
    CheckboxModule,
    ButtonModule,
    FloatLabelModule,
    FormsModule,
    PanelModule,
    ToggleSwitchModule,
    InputTextModule,
    FieldsetModule,
    TextConfigurationComponent,
    ClassificationConfigurationComponent,
    PixelsConfigurationComponent,
    GenericsModule,
    ToastModule,
    SelectButtonModule,
    ProgressBarModule,
  ],
  providers: [MessageService],
  templateUrl: './project-configuration.component.html',
  styleUrl: './project-configuration.component.scss',
})
export class ProjectConfigurationComponent implements OnInit, AfterViewInit {
  isInputValid: boolean = true;
  isOutputValid: boolean = true;
  isNameValid: boolean = true;
  fileLoading: boolean = false;

  constructor(
    public projectService: ProjectService,
    public labelService: LabelsService,
    private cli: CLIService,
    private cdr: ChangeDetectorRef,
    private viewService: ViewService,
    public editorService: EditorService,
    private clipboard: Clipboard,
    private messageService: MessageService
  ) {}

  ngOnInit(): void {
    this.cli.commandProcessed.subscribe((value) => {
      if (value) {
        this.cdr.detectChanges();
      }
    });
  }

  openInputFolder() {
    const file = open({ directory: true });
    file.then((value) => {
      if (value) {
        if (value != this.projectService.inputFolder) {
          this.projectService.resetProject();
        }
        this.projectService.inputFolder = value;
      }
    });
  }
  openOutputFolder() {
    const file = open({ directory: true });
    file.then((value) => {
      if (value) this.projectService.outputFolder = value;
    });
  }

  async startProject() {
    // Validate input
    this.isInputValid = this.projectService.inputFolder !== '';
    this.isOutputValid = this.projectService.outputFolder !== '';
    this.isNameValid = this.projectService.projectName !== '';

    if (this.isInputValid && this.isOutputValid) {
      await this.projectService.startProject();
      this.viewService.navigateToGallery();
    }
  }

  async loadProjectFromFilepath(filepath: string, start: boolean) {
    this.messageService.add({
      key: 'pathCopiedToClipboard',
      severity: 'success',
      summary: 'Filepath copied to clipboard',
    });
    this.clipboard.copy(filepath);
    filepath = await path.join(filepath, 'project_config.json');
    await this.projectService.loadProjectFile(filepath, start).then;
    this.updateFileCounter();
    if (start) {
      await this.viewService.navigateToGallery();
    }
  }

  findAndLoadProjectFile() {
    const file = open({ directory: false });
    file.then((value) => {
      if (value) {
        this.projectService.loadProjectFile(value);
      }
    });
  }
  async updateFileCounter() {
    if (this.fileLoading) return;

    this.fileLoading = true;
    this.projectService.listFiles().then(() => {
      this.fileLoading = false;
    });
  }
  removeProjectFromFilepath(filepath: string) {
    this.projectService.removeProjectFile(filepath);
  }

  async ngAfterViewInit() {
    this.debug();
    // this.viewService.navigateToTestZone();
  }

  async debug() {
    this.editorService.penPostProcess = false;
    this.editorService.postProcessOption = PostProcessOption.OTSU;
    this.editorService.lineWidth = 50;
    await this.projectService
      .loadProjectFile(
        "C:/Users/cleme/Documents/data/multiImageTest/Multi-ImageTest/project_config.json",
        true
      )
      .then(() => {
        // this.viewService.navigateToExport();
        this.viewService.openEditor(1);
      });
  }
}
