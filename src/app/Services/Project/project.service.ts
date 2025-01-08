import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { environment } from '../../../environments/environment';
import { ViewService } from '../UI/view.service';

import { path } from '@tauri-apps/api';
import { ProjectConfig, ProjectFile, SegLabel, Thumbnail } from '../../Core/interface';

import { loadImageFile } from '../../Core/io/images';
import { LabelsService } from './labels.service';
import { getDefaultColor } from '../../Core/misc/colors';
import { MulticlassTask, MultilabelTask } from '../../Core/task';
import {
  invokeLoadJsonFile,
  saveProjectConfigFile,
} from '../../Core/io/save_load';

@Injectable({
  providedIn: 'root',
})
export class ProjectService {
  isClassification: boolean = false;
  isSegmentation: boolean = false;
  isInstanceSegmentation: boolean = false;
  isBoundingBoxDetection: boolean = false;

  inputRegex: string = environment.defaultRegex;
  recursive: boolean = true;
  isProjectStarted: boolean = false;
  projectName: string = environment.defaultProjectName;
  outputFolder: string = environment.defaultOutputFolder;
  inputFolder: string = environment.defaultInputFolder;

  projectFolder: string = '';
  imagesName: string[] = [];

  localStoragesProjectsFilepaths: ProjectFile[] = [];
  thumbnails$: Promise<Array<Thumbnail>>;

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
    this.viewService.setLoading(true, 'Starting project...');
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
    };

    saveProjectConfigFile(this.projectFolder, projectConfig);

    // Save ProjectName/config file path to localStorage
    // Check if the projectFolder is already in the list, if so remove it
    const projectFile = {'project_name': this.projectName, 'root': await path.join(this.outputFolder, this.projectName)};
    const existingRoots = this.localStoragesProjectsFilepaths.map((projectFile) => projectFile.root);
  
    if (!existingRoots.includes(projectFile.root)) {
      this.localStoragesProjectsFilepaths.push(projectFile);
      localStorage.setItem(
        'projects',
        JSON.stringify(this.localStoragesProjectsFilepaths)
      );
    }

    return this.listFiles();
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
    let fileList$ = invoke('list_files_in_folder', {
      folder: this.inputFolder,
      regexfilter: this.inputRegex,
      recursive: this.recursive,
    });
    return fileList$
      .then((value: any) => {
        if (value) {
          this.viewService.setLoading(
            true,
            value.length + ' images found. Generating thumbnails...'
          );
          this.extractImagesName(value);
          this.generateThumbnails();
        }
      })
      .then(() => {
        this.isProjectStarted = true;
        this.viewService.navigateToGallery();
        this.viewService.endLoading();
      });
  }

  extractImagesName(files: string[]) {
    this.imagesName = files.map((file) => {
      let filename = file.split(this.inputFolder)[1];
      return filename;
    });
  }

  async generateThumbnails() {
    let output_folder = await path.join(this.projectFolder, 'thumbnails');
    let thumbnails$ = invoke<boolean[] | null>('create_thumbnails', {
      params: {
        image_names: this.imagesName,
        input_folder: this.inputFolder,
        output_folder: output_folder,
        width: this.viewService.thumbnailsSize,
        height: this.viewService.thumbnailsSize,
      },
    });
    this.thumbnails$ = thumbnails$.then(() => {
      return Promise.all(
        this.imagesName.map(async (image, index) => {
          return {
            thumbnailPath: loadImageFile(await path.join(output_folder, image)),
            name: path.basename(image),
          };
        })
      );
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

  create_project(config: ProjectConfig) {
    this.isClassification = config.is_classification;
    this.isSegmentation = config.is_segmentation;
    this.isInstanceSegmentation = config.is_instance_segmentation;
    this.isBoundingBoxDetection = config.is_bbox_detection;
    this.projectName = config.project_name;
    this.inputFolder = config.input_dir;
    this.outputFolder = config.output_dir;

    if (config.segmentation_classes) {
      this.labelService.listSegmentationLabels =
        config.segmentation_classes.map((label, index) => {
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

    this.labelService.rebuildTreeNodes();
  }
}
