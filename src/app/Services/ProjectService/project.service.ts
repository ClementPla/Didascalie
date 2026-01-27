import { Injectable, signal, computed } from '@angular/core';
import { api, ProjectConfig, ScanResult } from '../../lib/api';
import { LabelsService } from '../Labels/labels.service';
// ==========================================
// Types
// ==========================================

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  name: '',
  input_folder: null,
  images_embedded: false,
  embed_threshold_kb: 100,
  segmentation_enabled: true,
  classification_enabled: false,
  instance_segmentation_enabled: false,
  text_description_enabled: false, // Add this
  input_regex: '\\.(png|jpe?g|bmp|tiff?)$',
  recursive: true,
  folders_as_sequences: false,
  segmentation_labels: [],
  classification_tasks: [],
  multilabel_task: undefined,
  text_fields: [],
};

export interface RecentProject {
  name: string;
  path: string;
}

// ==========================================
// Service
// ==========================================

@Injectable({ providedIn: 'root' })
export class ProjectService {
  // Private state
  private readonly _config = signal<ProjectConfig>(DEFAULT_PROJECT_CONFIG);
  private readonly _projectPath = signal<string | null>(null);
  private readonly _isOpen = signal(false);
  private readonly _framesCount = signal(0);
  private readonly _sequencesCount = signal(0);
  // Add to computed conveniences section
  readonly isTextDescriptionEnabled = computed(
    () => this._config().text_description_enabled
  );

  // Public readonly signals
  readonly config = this._config.asReadonly();
  readonly projectPath = this._projectPath.asReadonly();
  readonly isOpen = this._isOpen.asReadonly();
  readonly framesCount = this._framesCount.asReadonly();
  readonly sequencesCount = this._sequencesCount.asReadonly();

  // Computed conveniences (for template binding)
  readonly projectName = computed(() => this._config().name);
  readonly inputFolder = computed(() => this._config().input_folder);
  readonly isSegmentation = computed(() => this._config().segmentation_enabled);
  readonly isClassification = computed(
    () => this._config().classification_enabled
  );
  readonly isInstanceSegmentation = computed(
    () => this._config().instance_segmentation_enabled
  );
  readonly inputRegex = computed(() => this._config().input_regex);
  readonly recursive = computed(() => this._config().recursive);
  readonly foldersAsSequences = computed(
    () => this._config().folders_as_sequences
  );
  readonly imagesEmbedded = computed(() => this._config().images_embedded);
  // For backward compatibility in templates
  readonly hasTextDescription = this.isTextDescriptionEnabled;

  // ==========================================
  // Config Updates (before project is created)
  // ==========================================

  constructor(private labelService: LabelsService) {}

  updateConfig(partial: Partial<ProjectConfig>): void {
    this._config.update((current) => ({ ...current, ...partial }));
  }

  setName(name: string): void {
    this.updateConfig({ name });
  }

  setInputFolder(folder: string): void {
    this.updateConfig({ input_folder: folder });
    // Auto-set project name from folder if empty
    if (!this._config().name) {
      const folderName = folder.split(/[/\\]/).pop() ?? 'Project';
      this.updateConfig({ name: folderName });
    }
  }

  setSegmentationEnabled(enabled: boolean): void {
    this.updateConfig({ segmentation_enabled: enabled });
  }

  setClassificationEnabled(enabled: boolean): void {
    this.updateConfig({ classification_enabled: enabled });
  }

  setInstanceSegmentationEnabled(enabled: boolean): void {
    this.updateConfig({ instance_segmentation_enabled: enabled });
  }

  setInputRegex(regex: string): void {
    this.updateConfig({ input_regex: regex });
  }

  setRecursive(recursive: boolean): void {
    this.updateConfig({ recursive });
  }

  setFoldersAsSequences(asSequences: boolean): void {
    this.updateConfig({ folders_as_sequences: asSequences });
  }

  setImagesEmbedded(embedded: boolean): void {
    this.updateConfig({ images_embedded: embedded });
  }

  // Add setter method
  setTextDescriptionEnabled(enabled: boolean): void {
    this.updateConfig({ text_description_enabled: enabled });
  }

  // ==========================================
  // Project Lifecycle
  // ==========================================

  async create(path: string): Promise<void> {
    const config = { ...this._config(), ...this.labelService.getDefinitions() };
    try {
      await api.createProject(config.name, path, config);
    } catch (error) {
      console.error('Failed to create project:', error);
      throw error;
    }

    this._projectPath.set(path);
    this._isOpen.set(true);

    // Add to recent projects
    this.addToRecentProjects(config.name, path);
  }

  async open(path: string): Promise<void> {
    const config = await api.openProject(path);
    this._config.set(config);
    await this.labelService.setDefinitions(config);  // Now async
    this._projectPath.set(path);
    this._isOpen.set(true);
    // Update counts
    await this.refreshCounts();
    // Add to recent projects
    this.addToRecentProjects(config.name, path);
  }

  async close(): Promise<void> {
    if (this._isOpen()) {
      await api.closeProject();
    }
    this.labelService.resetAll();
    this.reset();
  }

  // ==========================================
  // Folder Scanning
  // ==========================================

  async scanFolder(): Promise<ScanResult> {
    const config = this._config();
    if (!config.input_folder) {
      throw new Error('No input folder set');
    }

    const result = await api.scanAndImportFolder({
      folder_path: config.input_folder,
      embed_images: config.images_embedded,
      embed_threshold_kb: config.embed_threshold_kb,
      input_regex: config.input_regex,
      recursive: config.recursive,
      folders_as_sequences: config.folders_as_sequences,
    });

    // Update counts after scan
    await this.refreshCounts();

    return result;
  }

  async refreshCounts(): Promise<void> {
    if (!this._isOpen()) return;

    const framesCount = await api.getFramesCount();
    const sequencesCount = await api.getSequencesCount();

    this._framesCount.set(framesCount);
    this._sequencesCount.set(sequencesCount);
  }

  // ==========================================
  // Recent Projects (localStorage)
  // ==========================================

  private readonly STORAGE_KEY = 'labelmed_recent_projects';

  getRecentProjects(): RecentProject[] {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  addToRecentProjects(name: string, path: string): void {
    const recent = this.getRecentProjects().filter((p) => p.path !== path);
    recent.unshift({ name, path });
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(recent.slice(0, 10)));
  }

  removeFromRecentProjects(path: string): void {
    const recent = this.getRecentProjects().filter((p) => p.path !== path);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(recent));
  }

  // ==========================================
  // Validation
  // ==========================================

  isConfigValid(): boolean {
    const config = this._config();
    return !!(config.name && config.input_folder);
  }

  // ==========================================
  // Reset
  // ==========================================

  reset(): void {
    this._config.set(DEFAULT_PROJECT_CONFIG);
    this._projectPath.set(null);
    this._isOpen.set(false);
    this._framesCount.set(0);
    this._sequencesCount.set(0);
  }

  get maxInstances(): number {
    return 100; // Placeholder value; replace with actual logic if needed
  }
}
