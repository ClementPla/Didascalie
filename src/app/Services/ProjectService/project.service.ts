import { Injectable } from '@angular/core';

import { ProjectFile } from '../../Core/interface';
import { ProjectConfig } from '../TauriEvent/interface';
// Sub-services
import { ProjectConfigService } from './project-config.service';
import { ProjectFileService } from './project-file.service';
import { ProjectStorageService } from './project-storage.service';
import { ProjectRevisionService } from './project-revision.service';

// Related services
import { ClassificationService } from '../Labels/classification.service';
import { MultiframesService } from '../multiframes.service';

/**
 * Main project service - facade that orchestrates project operations.
 *
 * Delegates to specialized services:
 * - ProjectConfigService: Configuration and type flags
 * - ProjectFileService: File listing and path operations
 * - ProjectStorageService: Recent projects in localStorage
 * - ProjectRevisionService: Tracking reviewed images
 */
@Injectable({
  providedIn: 'root',
})
export class ProjectService {
  // ==========================================
  // Project State
  // ==========================================

  isProjectStarted = false;
  imagesName: string[] = [];
  annotationsName: string[] = [];
  activeIndex: number | null = null;
  activeImage: string | null = null;

  constructor(
    private configService: ProjectConfigService,
    private fileService: ProjectFileService,
    private storageService: ProjectStorageService,
    private revisionService: ProjectRevisionService,
    private classificationService: ClassificationService,
    private multiframesService: MultiframesService
  ) {}

  // ==========================================
  // Config Proxies (for backward compatibility)
  // ==========================================

  get isClassification(): boolean {
    return this.configService.isClassification;
  }
  set isClassification(value: boolean) {
    this.configService.isClassification = value;
  }

  get isSegmentation(): boolean {
    return this.configService.isSegmentation;
  }
  set isSegmentation(value: boolean) {
    this.configService.isSegmentation = value;
  }

  get isInstanceSegmentation(): boolean {
    return this.configService.isInstanceSegmentation;
  }
  set isInstanceSegmentation(value: boolean) {
    this.configService.isInstanceSegmentation = value;
  }

  get isBoundingBoxDetection(): boolean {
    return this.configService.isBoundingBoxDetection;
  }
  set isBoundingBoxDetection(value: boolean) {
    this.configService.isBoundingBoxDetection = value;
  }

  get hasTextDescription(): boolean {
    return this.configService.hasTextDescription;
  }
  set hasTextDescription(value: boolean) {
    this.configService.hasTextDescription = value;
  }

  get projectName(): string {
    return this.configService.projectName;
  }
  set projectName(value: string) {
    this.configService.projectName = value;
  }

  get inputFolder(): string {
    return this.configService.inputFolder;
  }
  set inputFolder(value: string) {
    this.configService.inputFolder = value;
  }

  get outputFolder(): string {
    return this.configService.outputFolder;
  }
  set outputFolder(value: string) {
    this.configService.outputFolder = value;
  }

  get inputRegex(): string {
    return this.configService.inputRegex;
  }
  set inputRegex(value: string) {
    this.configService.inputRegex = value;
  }

  get recursive(): boolean {
    return this.configService.recursive;
  }
  set recursive(value: boolean) {
    this.configService.recursive = value;
  }

  get folderAsMultiframes(): boolean {
    return this.configService.folderAsMultiframes;
  }
  set folderAsMultiframes(value: boolean) {
    this.configService.folderAsMultiframes = value;
  }

  get groupLabels(): boolean {
    return this.configService.groupLabels;
  }
  set groupLabels(value: boolean) {
    this.configService.groupLabels = value;
  }

  get maxInstances(): number {
    return this.configService.maxInstances;
  }
  set maxInstances(value: number) {
    this.configService.maxInstances = value;
  }

  get generateThumbnails(): boolean {
    return this.configService.generateThumbnails;
  }
  set generateThumbnails(value: boolean) {
    this.configService.generateThumbnails = value;
  }

  get projectFolder(): string {
    return this.configService.projectFolder;
  }

  // Storage proxies
  get localStoragesProjectsFilepaths(): ProjectFile[] {
    return [...this.storageService.recentProjects];
  }

  // Revision proxies
  get imagesHasBeenOpened(): readonly string[] {
    return this.revisionService.openedImages;
  }

  // ==========================================
  // Project Lifecycle
  // ==========================================

  /**
   * Starts the current project configuration.
   */
  async startProject(): Promise<void> {
    // Resolve paths
    await this.configService.resolvePaths();

    // Save configuration
    await this.configService.saveConfig();

    // Register in recent projects
    this.storageService.addProject({
      project_name: this.configService.projectName,
      root: this.configService.projectFolder,
    });

    // List files
    await this.listFiles();

    // Initialize revision tracking
    await this.revisionService.initialize(this.configService.projectFolder);

    this.isProjectStarted = true;
  }

  /**
   * Creates a project from a configuration object.
   */
  async createProject(config: ProjectConfig, start = true): Promise<boolean> {
    await this.configService.applyConfig(config);

    if (start) {
      await this.startProject();
    }

    return true;
  }

  /**
   * Loads a project from a config file.
   */
  async loadProjectFile(filepath: string, start = true): Promise<boolean> {
    const config = await this.configService.loadConfigFile(filepath);

    if (!config) {
      return false;
    }

    return this.createProject(config, start);
  }

  /**
   * Resets the project to initial state.
   */
  resetProject(): void {
    this.isProjectStarted = false;
    this.imagesName = [];
    this.annotationsName = [];
    this.activeIndex = null;
    this.activeImage = null;

    this.configService.reset();
    this.revisionService.reset();
  }

  // ==========================================
  // File Operations
  // ==========================================

  /**
   * Lists all image files in the input folder.
   */
  async listFiles(): Promise<void> {
    const fileList = await this.fileService.listFiles(
      this.configService.inputFolder,
      this.configService.inputRegex,
      this.configService.recursive
    );
    if (this.configService.folderAsMultiframes) {
      await this.multiframesService.groupFrames(
        this.configService.inputFolder,
        fileList
      );
    }

    this.imagesName = this.fileService.extractRelativeNames(
      fileList,
      this.configService.inputFolder
    );

    if (this.configService.isClassification) {
      this.classificationService.initMaps(this.imagesName);
    }
  }

  /**
   * Lists all annotation files in the project folder.
   */
  async listAnnotations(): Promise<void> {
    this.annotationsName = await this.fileService.listAnnotations(
      this.configService.projectFolder
    );
  }

  /**
   * Extracts relative image names from full file paths.
   * @deprecated Use fileService.extractRelativeNames directly
   */
  extractImagesName(files: string[]): string[] {
    return this.fileService.extractRelativeNames(
      files,
      this.configService.inputFolder
    );
  }

  // ==========================================
  // Revision Tracking
  // ==========================================

  /**
   * Updates the list of reviewed images.
   */
  async updateReviewedStatus(): Promise<void> {
    if (this.activeIndex !== null) {
      const currentImage = this.imagesName[this.activeIndex];
      if (currentImage) {
        await this.revisionService.markAsOpened(currentImage);
      }
    }
  }

  // ==========================================
  // Storage Operations
  // ==========================================

  /**
   * Removes a project from the recent projects list.
   */
  removeProjectFile(projectRoot: string): void {
    this.storageService.removeProject(projectRoot);
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  getTotalImages(): number {
    return this.imagesName.length;
  }

  /**
   * Gets the progress of reviewed images.
   */
  getReviewProgress(): { opened: number; total: number; percentage: number } {
    return this.revisionService.getProgress(this.imagesName.length);
  }

  /**
   * Checks if an image has been reviewed.
   */
  hasImageBeenOpened(imageName: string): boolean {
    return this.revisionService.hasBeenOpened(imageName);
  }
  /**
   * Create a new project from CLI configuration.
   * Handles all domain logic for project initialization.
   */
  createProjectFromCLI(config: ProjectConfig): void {
    this.createProject(config);
    this.isProjectStarted = true;
    console.log('Project created from CLI:', config);
  }

  /**
   * Register an image in the project.
   * Returns true if image was newly added, false if already present.
   */
  registerImage(relativePath: string): boolean {
    if (this.imagesName.includes(relativePath)) {
      console.log(`Image already registered: ${relativePath}`);
      return false;
    }

    this.imagesName.push(relativePath);
    console.log(`Image registered: ${relativePath}`);
    return true;
  }
}
