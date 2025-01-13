import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
} from '@angular/core';

import { ToolbarModule } from 'primeng/toolbar';

import { ViewService } from './Services/UI/view.service';
import { LoadingComponent } from './Components/Interface/loading/loading.component';
import { RouterOutlet } from '@angular/router';
import { NgIf } from '@angular/common';
import { ProjectService } from './Services/Project/project.service';
import { Button } from 'primeng/button';
import { RouterModule } from '@angular/router';
import { environment } from '../environments/environment';
import { LabelsService } from './Services/Project/labels.service';
import { EditorService } from './Services/UI/editor.service';
import { path } from '@tauri-apps/api';
import { CLIService } from './Services/cli.service';
import { IOService } from './Services/io.service';
import { ImageFromCLI } from './Core/interface';

import { PrimeNG } from 'primeng/config';
import Aura from '@primeng/themes/aura';
import Material from '@primeng/themes/material';
import Lara from '@primeng/themes/lara';
import Nora from '@primeng/themes/nora';
import { MulticlassTask, MultilabelTask } from './Core/task';
import { BlockUIModule } from 'primeng/blockui';


@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    ToolbarModule,
    LoadingComponent,
    NgIf,
    RouterOutlet,
    Button,
    RouterModule,
    BlockUIModule
  ],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements AfterViewInit {
  title = 'Client';

  constructor(
    public viewService: ViewService,
    public projectService: ProjectService,
    public editorService: EditorService,
    private labelService: LabelsService,
    private cli: CLIService,
    private cdr: ChangeDetectorRef,
    private IOService: IOService,
    private primeNG: PrimeNG
  ) {
    this.primeNG.theme.set({
      preset: Nora,
      options: {
        darkModeSelector: '.darkTheme',
        cssLayer: {
          name: 'primeng',
          order: 'tailwind-base, primeng, tailwind-utilities',
        },
      },
    });
    this.createCLISubscription();
  }

  createCLISubscription() {
    // Not sure if this is the right way to do or even needed
    this.cli.commandProcessed.subscribe((value) => {
      if (value) {
        this.cdr.detectChanges();
      }
    });
    this.cli.projectCreated.subscribe((config) => {
      if (config) {
        this.projectService.create_project(config);
      }
    });
    this.cli.imageLoaded.subscribe((imageConfig) => {
      if (imageConfig) {
        this.load_image(imageConfig);
      }
    });
  }
  ngAfterViewInit() {
    this.debug();
  }

  async debug() {
    this.projectService.isClassification = true;
    this.labelService.addSegLabel({
      label: 'Foreground',
      color: '#209fb5',
      isVisible: true,
      shades: null,
    });
    this.labelService.addSegLabel({
      label: 'Example1/Class 1',
      color: '#df8e1d',
      isVisible: true,
      shades: null,
    });
    this.labelService.addSegLabel({
      label: 'Example1/Class 2',
      color: '#8839ef',
      isVisible: true,
      shades: null,
    });
    this.labelService.addSegLabel({
      label: 'Example2/Class 3',
      color: '#d20f39',
      isVisible: true,
      shades: null,
    });
    this.projectService.isClassification = true;
    this.labelService.addClassificationTask(new MulticlassTask('DR Grading', 
      ['Absent', 'Mild', 'Moderate', 'Severe', 'Proliferative'], 'Absent'));
    this.labelService.addClassificationTask(new MulticlassTask('Quality', ['Good', 'Readable', 'Ungradable']));
    this.labelService.addMultilabelTask(new MultilabelTask('Misc', ['AMD', 'Glaucoma', 'Catract', 'Hypertension']));
    this.projectService.isSegmentation = true;
    this.editorService.autoPostProcess = true;

    let isStarted$ = this.projectService.startProject();
    isStarted$.then(() => {
      this.projectService.openEditor(0);
    });
  }

  async load_image(imageConfig: ImageFromCLI) {

    this.viewService.setLoading(true, 'Loading image');
    const file = imageConfig.image_path;

    // Start project and get resolved path
    if(!this.projectService.isProjectStarted) {
      await this.projectService.startProject();
    }
    else {
      await this.projectService.listFiles();
    }
    const resolvedFile = await path.resolve(file);

    // Find image index
    const filename = resolvedFile.split(this.projectService.inputFolder)[1];
    const index = this.projectService.imagesName.findIndex(
      (value) => value === filename
    );

    this.projectService.activeIndex = index;
    // Save masks
    await this.IOService.saveFromCLI(imageConfig);
    this.viewService.endLoading();
  }

  isProjectStarted(){
    return this.projectService.isProjectStarted;
  }
}
