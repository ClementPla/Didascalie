import { Injectable } from '@angular/core';

import { environment } from '../../../environments/environment';
import { SegLabel } from '../../Core/interface';
import { ProjectConfig } from '../TauriEvent/interface';
import { MulticlassTask, MultilabelTask } from '../../Core/task';
import { getDefaultColor } from '../../Core/misc/colors';
import { invokeLoadJsonFile, saveProjectConfigFile } from '../../Core/save_load';
import { LabelsService } from '../Labels/labels.service';
import { ProjectFileService } from './project-file.service';

const CONFIG_FILENAME = 'project_config.json';

/**
 * Manages project configuration - type flags, settings, and persistence.
 */
@Injectable({
  providedIn: 'root',
})
export class ProjectConfigService {
  // ==========================================
  // Project Type Flags
  // ==========================================

  isClassification = false;
  isSegmentation = false;
  isInstanceSegmentation = false;
  isBoundingBoxDetection = false;
  hasTextDescription = false;

  // ==========================================
  // Project Settings
  // ==========================================

  projectName = environment.defaultProjectName;
  inputFolder = environment.defaultInputFolder;
  outputFolder = environment.defaultOutputFolder;
  inputRegex = environment.defaultRegex;
  recursive = true;
  folderAsMultiframes = false;
  groupLabels = false;
  maxInstances = 100;
  generateThumbnails = true;

  // ==========================================
  // Derived Paths
  // ==========================================

  projectFolder = '';

  constructor(
    private labelService: LabelsService,
    private fileService: ProjectFileService
  ) {}

  // ==========================================
  // Configuration Loading
  // ==========================================

  /**
   * Loads a project configuration from a file.
   * @returns The parsed config, or null if loading failed
   */
  async loadConfigFile(configFilePath: string): Promise<ProjectConfig | null> {
    try {
      const rawConfig = await invokeLoadJsonFile(configFilePath);

      if (!rawConfig) {
        console.warn('No project config found at:', configFilePath);
        return null;
      }

      const config = typeof rawConfig === 'string' 
        ? JSON.parse(rawConfig) as ProjectConfig
        : rawConfig as ProjectConfig;
      return this.resolveConfigPaths(config, configFilePath);
    } catch (error) {
      console.error('Failed to load project config:', error);
      return null;
    }
  }

  /**
   * Applies a configuration to the service state.
   */
  async applyConfig(config: ProjectConfig): Promise<void> {
    // Apply type flags
    this.isClassification = config.is_classification;
    this.isSegmentation = config.is_segmentation;
    this.isInstanceSegmentation = config.is_instance_segmentation;
    this.isBoundingBoxDetection = config.is_bbox_detection;
    this.hasTextDescription = config.has_text_description;

    // Apply settings
    this.projectName = config.project_name;
    this.inputFolder = config.input_dir;
    this.outputFolder = config.output_dir;
    this.groupLabels = config.group_labels;
    this.folderAsMultiframes = config.is_multiframes;

    // Compute derived paths
    this.projectFolder = await this.fileService.getProjectFolder(
      this.outputFolder,
      this.projectName
    );

    // Setup labels
    await this.setupLabelsFromConfig(config);
  }

  // ==========================================
  // Configuration Saving
  // ==========================================

  /**
   * Saves the current configuration to the project folder.
   */
  async saveConfig(): Promise<void> {
    const config = this.buildConfig();
    await saveProjectConfigFile(this.projectFolder, config);
  }

  /**
   * Builds a ProjectConfig from current state.
   */
  buildConfig(): ProjectConfig {
    return {
      project_name: this.projectName,
      input_dir: this.inputFolder,
      output_dir: this.outputFolder,
      is_classification: this.isClassification,
      is_segmentation: this.isSegmentation,
      is_instance_segmentation: this.isInstanceSegmentation,
      is_bbox_detection: this.isBoundingBoxDetection,
      is_multiframes: this.folderAsMultiframes,
      group_labels: this.groupLabels,
      segmentation_classes: this.labelService.listSegmentationLabels.map(
        (label) => label.label
      ),
      classification_classes: this.labelService.listClassificationTasks.map(
        (task) => ({
          name: task.taskName,
          classes: task.classLabels,
        })
      ),
      classification_multilabel: this.labelService.multiLabelTask
        ? {
            name: this.labelService.multiLabelTask.taskName,
            classes: this.labelService.multiLabelTask.taskLabels,
          }
        : null,
      has_text_description: this.hasTextDescription,
      text_names: this.labelService.listTextLabels.map((label) => label.name),
      default_colors: this.isSegmentation
        ? this.labelService.listSegmentationLabels.map((label) => label.color)
        : null,
    };
  }

  // ==========================================
  // Path Resolution
  // ==========================================

  /**
   * Resolves paths in the service and normalizes input folder.
   */
  async resolvePaths(): Promise<void> {
    this.inputFolder = await this.fileService.normalizeInputPath(this.inputFolder);
    this.outputFolder = await this.fileService.resolvePath(this.outputFolder);
    this.projectFolder = await this.fileService.getProjectFolder(
      this.outputFolder,
      this.projectName
    );
  }

  // ==========================================
  // State Management
  // ==========================================

  /**
   * Resets configuration to defaults.
   */
  reset(): void {
    this.isClassification = false;
    this.isSegmentation = false;
    this.isInstanceSegmentation = false;
    this.isBoundingBoxDetection = false;
    this.hasTextDescription = false;

    this.projectName = environment.defaultProjectName;
    this.inputFolder = environment.defaultInputFolder;
    this.outputFolder = environment.defaultOutputFolder;
    this.inputRegex = environment.defaultRegex;
    this.recursive = true;
    this.folderAsMultiframes = false;
    this.groupLabels = false;

    this.projectFolder = '';
  }

  /**
   * Checks if any annotation type is enabled.
   */
  hasAnyAnnotationType(): boolean {
    return (
      this.isClassification ||
      this.isSegmentation ||
      this.isInstanceSegmentation ||
      this.isBoundingBoxDetection ||
      this.hasTextDescription
    );
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private async resolveConfigPaths(
    config: ProjectConfig,
    configFilePath: string
  ): Promise<ProjectConfig> {
    const configDir = this.fileService.getConfigDirectory(configFilePath);

    // Resolve relative input path
    if (config.input_dir.startsWith('.')) {
      config.input_dir = await this.fileService.resolveRelativePath(
        configDir,
        config.input_dir
      );
    }

    // Resolve relative output path
    if (config.output_dir.startsWith('.')) {
      config.output_dir = await this.fileService.resolveRelativePath(
        configDir,
        config.output_dir
      );
    }

    return config;
  }

  private async setupLabelsFromConfig(config: ProjectConfig): Promise<void> {
    this.labelService.resetAll();

    // Setup segmentation labels
    if (config.segmentation_classes) {
      this.labelService.listSegmentationLabels = config.segmentation_classes.map(
        (label, index) => this.createSegLabel(label, index, config.default_colors)
      );
    }

    // Setup classification tasks
    if (config.classification_classes) {
      for (const task of config.classification_classes) {
        this.labelService.addClassificationTask(
          new MulticlassTask(task.name, task.classes)
        );
      }
    }

    // Setup multilabel task
    if (config.classification_multilabel) {
      this.labelService.addMultilabelTask(
        new MultilabelTask(
          config.classification_multilabel.name,
          config.classification_multilabel.classes
        )
      );
    }

    // Setup text labels
    if (config.text_names) {
      for (const name of config.text_names) {
        this.labelService.addTextLabel({ name, text: '' });
      }
    }

    this.labelService.rebuildTreeNodes();
  }

  private createSegLabel(
    label: string,
    index: number,
    defaultColors: string[] | null
  ): SegLabel {
    return {
      label,
      color: defaultColors?.[index] ?? getDefaultColor(index + 1),
      isVisible: true,
      shades: null,
    };
  }

  
}