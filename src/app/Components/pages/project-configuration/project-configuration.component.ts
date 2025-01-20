import { ChangeDetectorRef, Component, OnInit, output } from '@angular/core';
import { DividerModule } from 'primeng/divider';
import { PanelModule } from 'primeng/panel';
import { FloatLabelModule } from 'primeng/floatlabel';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { NgClass, NgIf, NgFor } from '@angular/common';
import { InputSwitchModule } from 'primeng/inputswitch';
import { InputTextModule } from 'primeng/inputtext';
import { open } from '@tauri-apps/plugin-dialog';
import { FieldsetModule } from 'primeng/fieldset';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../environments/environment';
import { ProjectService } from '../../../Services/Project/project.service';
import { LabelsService } from '../../../Services/Project/labels.service';
import { getDefaultColor } from '../../../Core/misc/colors';
import { ColorPickerModule } from 'primeng/colorpicker';
import { CheckboxModule } from 'primeng/checkbox';
import { SegLabel } from '../../../Core/interface';
import { CLIService } from '../../../Services/cli.service';
import { ClassificationConfigurationComponent } from './classification-configuration/classification-configuration.component';
import { TableModule } from 'primeng/table';
import { CommonModule } from '@angular/common';
import { path } from '@tauri-apps/api';
import { GenericsModule } from '../../../generics/generics.module';
import { TextConfigurationComponent } from './text-configuration/text-configuration.component';
import { PixelsConfigurationComponent } from './pixels-configuration/pixels-configuration.component';

@Component({
  selector: 'app-project-configuration',
  standalone: true,
  imports: [
    CardModule,
    TableModule,
    CommonModule,
    ClassificationConfigurationComponent,
    NgClass,
    NgIf,
    DividerModule,
    ColorPickerModule,
    CheckboxModule,
    ButtonModule,
    FloatLabelModule,
    FormsModule,
    PanelModule,
    InputSwitchModule,
    InputTextModule,
    FieldsetModule,
    TextConfigurationComponent,
    ClassificationConfigurationComponent,
    PixelsConfigurationComponent,
    GenericsModule,
  ],
  templateUrl: './project-configuration.component.html',
  styleUrl: './project-configuration.component.scss',
})
export class ProjectConfigurationComponent implements OnInit {
  generateThumbnails: boolean = true;

  isInputValid: boolean = true;
  isOutputValid: boolean = true;
  isNameValid: boolean = true;
  constructor(
    public projectService: ProjectService,
    public labelService: LabelsService,
    private cli: CLIService,
    private cdr: ChangeDetectorRef
  ) { }

  ngOnInit(): void {
    this.cli.commandProcessed.subscribe((value) => {
      if (value) {
        console.log('Command processed from Project Configuration');
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

  startProject() {
    // Validate input
    this.isInputValid = this.projectService.inputFolder !== '';
    this.isOutputValid = this.projectService.outputFolder !== '';
    this.isNameValid = this.projectService.projectName !== '';
    if (this.isInputValid && this.isOutputValid) {
      this.projectService.startProject();
    }
  }



  async loadProjectFromFilepath(filepath: string) {
    filepath = await path.join(filepath, 'project_config.json')
    this.projectService.loadProjectFile(filepath);
  }

  findAndLoadProjectFile() {
    const file = open({ directory: false });
    file.then((value) => {
      if (value) {
        this.projectService.loadProjectFile(value);
      }
    });
  }

  removeProjectFromFilepath(filepath: string) {
    this.projectService.removeProjectFile(filepath);
  }

}
