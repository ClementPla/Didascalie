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
import { LabelsService } from '../../../Services/Labels/labels.service';
import { ColorPickerModule } from 'primeng/colorpicker';
import { CheckboxModule } from 'primeng/checkbox';
import { ClassificationConfigurationComponent } from './classification-configuration/classification-configuration.component';
import { TableModule } from 'primeng/table';
import { path } from '@tauri-apps/api';
import { GenericsModule } from '../../../generics/generics.module';
import { TextConfigurationComponent } from './text-configuration/text-configuration.component';
import { PixelsConfigurationComponent } from './pixels-configuration/pixels-configuration.component';
import { EditorService } from '../editor/services/editor.service';
import { SelectButtonModule } from 'primeng/selectbutton';
import { CommonModule } from '@angular/common';
import { Clipboard } from '@angular/cdk/clipboard';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { PostProcessOption } from '../../../Core/tools';
import { ProgressBarModule } from 'primeng/progressbar';
import { UIStateService } from '../../../Services/uistate.service';
import { NavigationService } from '../../../Services/Navigation/navigation.service';
import { debounceTime, Subject, switchMap, tap } from 'rxjs';

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
export class ProjectConfigurationComponent implements AfterViewInit {
  isInputValid: boolean = true;
  isOutputValid: boolean = true;
  isNameValid: boolean = true;
  fileLoading: boolean = false;
  private searchTrigger$ = new Subject<void>();
  constructor(
    public projectService: ProjectService,
    public labelService: LabelsService,
    public editorService: EditorService,
    public uiStateService: UIStateService,
    private clipboard: Clipboard,
    private messageService: MessageService,
    private navigationService: NavigationService,
    private cdr: ChangeDetectorRef
  ) {
    this.setupSearchDebounce();
  }


  setupSearchDebounce() {
    // 2. Setup the pipeline
    this.searchTrigger$.pipe(
      debounceTime(300), // Wait for user to stop typing/clicking
      tap(() => {
        this.fileLoading = true;
        this.cdr.detectChanges(); // Ensure bar shows up immediately
      }),
      // switchMap handles the async call and cancels previous "in-flight" requests
      switchMap(() => this.projectService.listFiles())
    ).subscribe({
      next: () => {
        this.fileLoading = false;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error(err);
        this.fileLoading = false;
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
      this.uiStateService.navigateToGallery();
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
      await this.uiStateService.navigateToGallery();
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
    this.searchTrigger$.next();
  }
  removeProjectFromFilepath(filepath: string) {
    this.projectService.removeProjectFile(filepath);
  }

  async ngAfterViewInit() {
    // this.debug();
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
    await this.uiStateService.navigateToGallery();

  }
}
