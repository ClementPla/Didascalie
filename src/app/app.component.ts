import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
} from '@angular/core';

import { ToolbarModule } from 'primeng/toolbar';

import { ViewService } from './Services/UI/view.service';
import { LoadingComponent } from './Components/pages/loading/loading.component';
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
import { IOService } from './Services/Project/io.service';
import { ImageFromCLI } from './Core/interface';
import { PostProcessOption } from './Core/tools';
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
      preset: Aura,
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
  /*
  * Create the subscriptions to CLI events.
  * The chain of calls is as followed: Tauri (via ZMQ.REP) listens to the localhost port. 
  * If a message is received, an event is sent to the application. Event is then processed by the CLI service.
  * The CLI service calls a Subject.next() to emit the payload to the application.
  */
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
        this.projectService.isProjectStarted = true;

      }
    });
    this.cli.imageLoaded.subscribe((imageConfig) => {
      if (imageConfig) {
        this.load_image(imageConfig);
      }
    });
  }
  ngAfterViewInit() {
    // this.debug();
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
    this.editorService.postProcessOption = PostProcessOption.CRF;
    this.editorService.lineWidth = 40;

    let isStarted$ = this.projectService.startProject();
    isStarted$.then(() => {
      this.projectService.openEditor(0);
    });
  }

  async load_image(imageConfig: ImageFromCLI) {
    let image_path = await path.resolve(imageConfig.image_path);
    // Get the image name: we split the path from projectService.inputFolder and get the last element of image_path
    // i.e image_path = projectService.inputFolder / image_name
    // The idea is to get not just the filename, but the path relative to the input folder
    let image_name = image_path.split(this.projectService.inputFolder)[1];

    console.log('Image name:', image_name);
    if (this.projectService.imagesName.includes(image_name)) {
    }
    else {
      this.projectService.imagesName.push(image_name);
    }
    await this.IOService.saveFromCLI(imageConfig, image_name);
  }

  isProjectStarted() {
    return this.projectService.isProjectStarted;
  }
}
