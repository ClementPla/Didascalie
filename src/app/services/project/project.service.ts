import { Injectable, signal, computed, inject } from '@angular/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  api,
  AddImagesResult,
  ImageFolderStatus,
  ProjectConfig,
  ProjectEdit,
  ScanOptions,
  ScanResult,
} from '../../lib/api';
import { LabelsService } from '../labels/labels.service';
import { NotificationService } from '../notification.service';
import { ProjectLifecycleService } from './project-lifecycle.service';
// ── Types ──────────────────────────────────────────────────────────────────

export const DEFAULT_PROJECT_CONFIG: ProjectConfig = {
  name: '',
  input_folder: null,
  images_embedded: false,
  embed_threshold_kb: 100,
  segmentation_enabled: true,
  classification_enabled: false,
  instance_segmentation_enabled: false,
  text_description_enabled: false, // Add this
  input_regex: '\\.(png|jpe?g|bmp|tiff?|mp4|m4v|mov|mkv|webm|avi)$',
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
  last_opened: number;
}

// ── Service ────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private labelService = inject(LabelsService);
  private lifecycle = inject(ProjectLifecycleService);
  private notifications = inject(NotificationService);

  private readonly STORAGE_KEY = 'didascalie_recent_projects';
  private readonly _config = signal<ProjectConfig>(DEFAULT_PROJECT_CONFIG);
  private readonly _projectPath = signal<string | null>(null);
  private readonly _isOpen = signal(false);
  private readonly _framesCount = signal(0);
  private readonly _sequencesCount = signal(0);
  private readonly _imageFolder = signal<ImageFolderStatus | null>(null);
  /** The image folder as this computer reaches it; null until a project is open. */
  readonly imageFolder = this._imageFolder.asReadonly();
  readonly isTextDescriptionEnabled = computed(
    () => this._config().text_description_enabled,
  );

  readonly config = this._config.asReadonly();
  readonly projectPath = this._projectPath.asReadonly();
  readonly isOpen = this._isOpen.asReadonly();
  readonly framesCount = this._framesCount.asReadonly();
  readonly sequencesCount = this._sequencesCount.asReadonly();

  readonly projectName = computed(() => this._config().name);
  readonly inputFolder = computed(() => this._config().input_folder);
  readonly isSegmentation = computed(() => this._config().segmentation_enabled);
  readonly isClassification = computed(
    () => this._config().classification_enabled,
  );
  readonly isInstanceSegmentation = computed(
    () => this._config().instance_segmentation_enabled,
  );
  readonly inputRegex = computed(() => this._config().input_regex);
  readonly recursive = computed(() => this._config().recursive);
  readonly foldersAsSequences = computed(
    () => this._config().folders_as_sequences,
  );
  readonly imagesEmbedded = computed(() => this._config().images_embedded);
  readonly hasTextDescription = this.isTextDescriptionEnabled;

  updateConfig(partial: Partial<ProjectConfig>): void {
    this._config.update((current) => ({ ...current, ...partial }));
  }

  setName(name: string): void {
    this.updateConfig({ name });
  }

  setInputFolder(folder: string): void {
    this.updateConfig({ input_folder: folder });
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

  /** Keep one frame out of this many from each video of the input folder. An
   *  import option, not part of the saved config. */
  readonly videoFrameStep = signal(1);

  setVideoFrameStep(step: number): void {
    this.videoFrameStep.set(Math.max(1, Math.floor(Number(step)) || 1));
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

  setTextDescriptionEnabled(enabled: boolean): void {
    this.updateConfig({ text_description_enabled: enabled });
  }

  // ── Project Lifecycle ────────────────────────────────────────────────────

  /**
   * Create a project, replacing whatever was open. The draft is captured before
   * `close()`, which resets the labels the form just defined, then merged over
   * the defaults.
   */
  async create(path: string): Promise<void> {
    const draft = { ...this._config(), ...this.labelService.getDefinitions() };

    await this.close();

    const config = { ...DEFAULT_PROJECT_CONFIG, ...draft };
    this._config.set(config);

    try {
      await api.createProject(config.name, path, config);
    } catch (error) {
      console.error('Failed to create project:', error);
      throw error;
    }

    // After the project exists: `setDefinitions` reads the labels back from the
    // database.
    await this.labelService.setDefinitions(config);

    this._projectPath.set(path);
    this._isOpen.set(true);
    await this.refreshImageFolder();

    this.addToRecentProjects(config.name, path);
  }

  /** Open a project, replacing whatever was open. The close comes first: ids
   *  restart at 1 in every project, and caches keyed by them would be reused. */
  async open(path: string): Promise<void> {
    await this.close();
    const config = await api.openProject(path);
    // Merged over the defaults: a file written by an older version can lack a
    // field.
    this._config.set({ ...DEFAULT_PROJECT_CONFIG, ...config });
    await this.labelService.setDefinitions(config); // Now async
    this._projectPath.set(path);
    this._isOpen.set(true);
    // A project made on another computer may name a folder this one reaches by
    // another path.
    await this.refreshImageFolder();
    if (this._imageFolder()?.missing && !(await this.locateImageFolder())) {
      this.notifications.warn(
        'Image folder not found',
        'Images will not load. Locate the folder from the project settings.',
      );
    }
    await this.refreshCounts();
    this.addToRecentProjects(config.name, path);
  }

  private async refreshImageFolder(): Promise<void> {
    try {
      this._imageFolder.set(await api.getImageFolder());
    } catch (error) {
      console.error('Failed to read the image folder:', error);
      this._imageFolder.set(null);
    }
  }

  /** Ask where the project's image folder is on this computer. False when
   *  nothing was chosen, or the folder is not the project's. */
  async locateImageFolder(): Promise<boolean> {
    const known = this._imageFolder()?.folder;
    const picked = await open({
      directory: true,
      title: known
        ? `Locate the image folder (${known})`
        : 'Locate the image folder',
    });
    if (typeof picked !== 'string' || !picked) return false;
    try {
      this._imageFolder.set(await api.setImageFolder(picked));
      return true;
    } catch (error) {
      this.notifications.error(
        'Could not use this folder',
        typeof error === 'string'
          ? error
          : ((error as { message?: string })?.message ?? String(error)),
      );
      return false;
    }
  }

  async close(): Promise<void> {
    if (this._isOpen()) {
      await api.closeProject();
    }
    // This service is not in the project-scoped list: it drives the lifecycle.
    this.lifecycle.resetAll();
    this.reset();
  }

  // ── Folder Scanning ──────────────────────────────────────────────────────

  async scanFolder(): Promise<ScanResult> {
    const config = this._config();
    if (!config.input_folder) {
      throw new Error('No input folder set');
    }

    const result = await api.scanAndImportFolder({
      folderPath: config.input_folder,
      embedImages: config.images_embedded,
      embedThresholdKb: config.embed_threshold_kb,
      inputRegex: config.input_regex,
      recursive: config.recursive,
      foldersAsSequences: config.folders_as_sequences,
      videoFrameStep: this.videoFrameStep(),
    });

    await this.refreshCounts();

    return result;
  }

  /** Add a folder's images to the open project. See `add_images_to_project`. */
  async addImages(options: ScanOptions): Promise<AddImagesResult> {
    const result = await api.addImagesToProject(options);
    await this.refreshCounts();
    return result;
  }

  // ── Editing an open project ──────────────────────────────────────────────

  /**
   * Apply one configuration change to the open project. The backend returns the
   * resulting configuration, which replaces the local copy. Callers go through
   * `ProjectSettingsService`, which flushes and drops the editor's in-memory
   * state around the edit.
   */
  async applyEdit(edit: ProjectEdit): Promise<void> {
    const config = await api.applyProjectEdit(edit);
    this._config.set({ ...DEFAULT_PROJECT_CONFIG, ...config });
    await this.labelService.setDefinitions(config);

    const path = this._projectPath();
    if (edit.type === 'renameProject' && path) {
      this.addToRecentProjects(config.name, path);
    }
  }

  async refreshCounts(): Promise<void> {
    if (!this._isOpen()) return;

    const framesCount = await api.getFramesCount();
    const sequencesCount = await api.getSequencesCount();

    this._framesCount.set(framesCount);
    this._sequencesCount.set(sequencesCount);
  }

  // ── Recent Projects (localStorage) ───────────────────────────────────────

  getRecentProjects(): RecentProject[] {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored) as Partial<RecentProject>[];
      // Older entries lack `last_opened`.
      return parsed
        .filter((p) => p && p.path && p.name)
        .map((p) => ({
          name: p.name!,
          path: p.path!,
          last_opened: typeof p.last_opened === 'number' ? p.last_opened : 0,
        }))
        .sort((a, b) => b.last_opened - a.last_opened);
    } catch {
      return [];
    }
  }

  addToRecentProjects(name: string, path: string): void {
    const now = Date.now();
    const recent = this.getRecentProjects().filter((p) => p.path !== path);
    recent.unshift({ name, path, last_opened: now });
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(recent.slice(0, 10)));
  }

  removeFromRecentProjects(path: string): void {
    const recent = this.getRecentProjects().filter((p) => p.path !== path);
    localStorage.setItem(this.STORAGE_KEY, JSON.stringify(recent));
  }
  // ── Validation ───────────────────────────────────────────────────────────

  isConfigValid(): boolean {
    const config = this._config();
    return !!(config.name && config.input_folder);
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  reset(): void {
    this._config.set(DEFAULT_PROJECT_CONFIG);
    this._projectPath.set(null);
    this._isOpen.set(false);
    this._imageFolder.set(null);
    this._framesCount.set(0);
    this._sequencesCount.set(0);
  }

  get maxInstances(): number {
    return 100; // Placeholder value; replace with actual logic if needed
  }
}
