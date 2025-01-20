import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { environment } from '../../../environments/environment';
import { ViewService } from '../UI/view.service';

import { path } from '@tauri-apps/api';
import { ProjectConfig, ProjectFile, SegLabel, Thumbnail } from '../../Core/interface';

import { invokeSaveJsonFile, loadImageFile } from '../../Core/save_load';
import { LabelsService } from './labels.service';
import { getDefaultColor } from '../../Core/misc/colors';
import { MulticlassTask, MultilabelTask } from '../../Core/task';
import {
  invokeLoadJsonFile,
  saveProjectConfigFile,
} from '../../Core/save_load';

@Injectable({
  providedIn: 'root',
})
export class ProjectService {
  isClassification: boolean = false;
  isSegmentation: boolean = false;
  isInstanceSegmentation: boolean = false;
  isBoundingBoxDetection: boolean = false;
  hasTextDescription: boolean = false;

  inputRegex: string = environment.defaultRegex;
  recursive: boolean = true;
  isProjectStarted: boolean = false;
  projectName: string = environment.defaultProjectName;
  outputFolder: string = environment.defaultOutputFolder;
  inputFolder: string = environment.defaultInputFolder;

  projectFolder: string = '';
  imagesName: string[] = [];
  annotationsName: string[] = [];

  imagesHasBeenOpened: string[] = [];

  localStoragesProjectsFilepaths: ProjectFile[] = [];

  activeIndex: number | null = null;
  activeImage: Promise<string> | null = null;

  maxInstances: number = 100;

  constructor(
    private viewService: ViewService,
    private labelService: LabelsService
  ) {

    this.localStoragesProjectsFilepaths = JSON.parse(
      localStorage.getItem('projects') || '[]'
    );

  }
  async startProject(): Promise<void> {
    this.inputFolder = await path.resolve(this.inputFolder);
    let sep = path.sep();
    if (!this.inputFolder.endsWith(sep)) {
      this.inputFolder = this.inputFolder + sep;
    }

    this.outputFolder = await path.resolve(this.outputFolder);
    this.projectFolder = await path.join(this.outputFolder, this.projectName);

    let projectConfig: ProjectConfig = {
      project_name: this.projectName,
      input_dir: this.inputFolder,
      output_dir: this.outputFolder,
      is_classification: this.isClassification,
      is_segmentation: this.isSegmentation,
      is_instance_segmentation: this.isInstanceSegmentation,
      is_bbox_detection: this.isBoundingBoxDetection,
      segmentation_classes: this.labelService.listSegmentationLabels.map(
        (label) => label.label
      ),
      classification_classes: this.labelService.listClassificationTasks.map(
        (task) => {
          return {
            name: task.taskName,
            classes: task.classLabels,
            default: task.choice,
          };
        }
      ),
      classification_multilabel: this.labelService.multiLabelTask
        ? {
          name: this.labelService.multiLabelTask.taskName,
          classes: this.labelService.multiLabelTask.taskLabels,
          default: this.labelService.multiLabelTask.choices,
        }
        : null,
      has_text_description: this.hasTextDescription,
      text_names: this.labelService.listTextLabels.map((label) => label.name),
      default_colors: this.isSegmentation ? this.labelService.listSegmentationLabels.map((label) => label.color) : null,
    };

    saveProjectConfigFile(this.projectFolder, projectConfig);

    // Save ProjectName/config file path to localStorage
    // Check if the projectFolder is already in the list, if so remove it
    const projectFile = { 'project_name': this.projectName, 'root': await path.join(this.outputFolder, this.projectName) };
    const existingRoots = this.localStoragesProjectsFilepaths.map((projectFile) => projectFile.root);

    if (!existingRoots.includes(projectFile.root)) {
      this.localStoragesProjectsFilepaths.push(projectFile);
      localStorage.setItem(
        'projects',
        JSON.stringify(this.localStoragesProjectsFilepaths)
      );
    }

    await this.listFiles();
    await this.update_reviewed();
    this.isProjectStarted = true;

    this.viewService.navigateToGallery();

  }

  async loadProjectFile(filepath: string) {
    return invokeLoadJsonFile(filepath).then((projectConfig: any) => {

      if (projectConfig) {
        // Convert JSON string to ProjectConfig

        projectConfig = JSON.parse(projectConfig);

        this.create_project(projectConfig as ProjectConfig);
      }
    });
  }

  async removeProjectFile(filepath: string) {
    this.localStoragesProjectsFilepaths = this.localStoragesProjectsFilepaths.filter(
      (projectFile) => projectFile.root !== filepath
    );
    localStorage.setItem(
      'projects',
      JSON.stringify(this.localStoragesProjectsFilepaths)
    );
  }

  async listFiles() {
    let fileList = await invoke<string[]>('list_files_in_folder', {
      folder: this.inputFolder,
      regexfilter: this.inputRegex,
      recursive: this.recursive,
    });
    this.extractImagesName(fileList);
  }

  async listAnnotations() {
    const inputPath = await path.join(this.projectFolder, 'annotations');
    let fileList = await invoke<string[]>('list_files_in_folder', {
      folder: inputPath,
      regexfilter: '.*.svg$',
      recursive: true,
    });
    this.annotationsName = fileList.map((file) => {
      let filename = file.split(inputPath + path.sep())[1];
      return filename;
    });
  }

  extractImagesName(files: string[]) {
    this.imagesName = files.map((file) => {
      let filename = file.split(this.inputFolder)[1];
      return filename;
    });
  }

  async openEditor(index: number) {
    this.viewService.setLoading(true, 'Loading editor');
    this.activeIndex = index;
    const openPromise$ = path
      .join(this.inputFolder, this.imagesName[index])
      .then((filepath) => {
        this.activeImage = loadImageFile(filepath);

        return this.activeImage.then((image) => {
          return this.viewService.navigateToEditor()?.then(() => {
            this.viewService.endLoading();
          });
        });
      });

    return openPromise$;
  }

  async goNext() {
    if (
      this.activeIndex != null &&
      this.activeIndex < this.imagesName.length - 1
    ) {
      return this.openEditor(this.activeIndex + 1);
    }
    return Promise.resolve('No more images');
  }

  async goPrevious() {
    if (this.activeIndex != null && this.activeIndex > 0) {
      return this.openEditor(this.activeIndex - 1);
    }
    return Promise.resolve('No more images');
  }
  resetProject() {
    this.isProjectStarted = false;
    this.imagesName = [];
    this.activeIndex = null;
    this.activeImage = null;
  }

  async create_project(config: ProjectConfig) {
    this.isClassification = config.is_classification;
    this.isSegmentation = config.is_segmentation;
    this.isInstanceSegmentation = config.is_instance_segmentation;
    this.isBoundingBoxDetection = config.is_bbox_detection;
    this.hasTextDescription = config.has_text_description
    this.projectName = config.project_name;
    this.inputFolder = config.input_dir;
    this.outputFolder = config.output_dir;
    this.projectFolder = await path.join(this.outputFolder, this.projectName);

    if (config.segmentation_classes) {
      this.labelService.listSegmentationLabels =
        config.segmentation_classes.map((label, index) => {
          if (config.default_colors) {
            return {
              label,
              color: config.default_colors[index],
              isVisible: true,
              shades: null,
            } as SegLabel;
          }
          return {
            label,
            color: getDefaultColor(index + 1),
            isVisible: true,
            shades: null,
          } as SegLabel;
        });
    }
    if (config.classification_classes) {
      config.classification_classes.forEach((task) => {
        this.labelService.addClassificationTask(
          new MulticlassTask(
            task.name,
            task.classes,
            task.default ? task.default : undefined
          )
        );
      });
    }
    if (config.classification_multilabel) {
      this.labelService.addMultilabelTask(
        new MultilabelTask(
          config.classification_multilabel.name,
          config.classification_multilabel.classes,
          config.classification_multilabel.default
            ? config.classification_multilabel.default
            : undefined
        )
      );
    }
    if (config.text_names) {
      config.text_names.forEach((name) => {
        this.labelService.addTextLabel({ 'name': name, "text": "" });
      });
    }
    this.labelService.rebuildTreeNodes();
    this.startProject();
  }
  async update_reviewed() {
    // Read the revision file and update the reviewed status
    const currentImage = this.imagesName[this.activeIndex!];

    if (!this.imagesHasBeenOpened.includes(currentImage)) {
      this.imagesHasBeenOpened.push(currentImage);
    }
    const revisionPath = await path.join(this.projectFolder, '.revisions.json');
    let revision;
    try {
      revision = await invokeLoadJsonFile(revisionPath).then((revisions: any) => {
        if (revisions) {
          revisions = JSON.parse(revisions).images;
          // Add the images that have been opened to the list if they are not already there
          this.imagesHasBeenOpened.forEach((image) => {
            if (!revisions.includes(image)) {
              revisions.push(image);
            }
          });
          return revisions;
        }
        else {
          return this.imagesHasBeenOpened;
        }
      });
    }
    catch (error) {
      revision = this.imagesHasBeenOpened;
    }
    this.imagesHasBeenOpened = revision;
    const revisionString = JSON.stringify({ images: this.imagesHasBeenOpened }, null, 2);
    invokeSaveJsonFile(revisionPath, revisionString);


  }
}
