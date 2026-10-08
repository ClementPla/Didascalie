import { Injectable, signal, computed, inject } from '@angular/core';
import {
  api,
  AddImagesResult,
  ProjectConfig,
  ProjectEdit,
  ScanOptions,
  ScanResult,
} from '../../lib/api';
import { LabelsService } from '../labels/labels.service';
import { ProjectLifecycleService } from './project-lifecycle.service';
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
  last_opened: number;
}

// ==========================================
// Service
// ==========================================

@Injectable({ providedIn: 'root' })
export class ProjectService {
  private labelService = inject(LabelsService);
  private lifecycle = inject(ProjectLifecycleService);

  // Private state
  private readonly STORAGE_KEY = 'didascalie_recent_projects';
  private readonly _config = signal<ProjectConfig>(DEFAULT_PROJECT_CONFIG);
  private readonly _projectPath = signal<string | null>(null);
  private readonly _isOpen = signal(false);
  private readonly _framesCount = signal(0);
  private readonly _sequencesCount = signal(0);
  // Add to computed conveniences section
  readonly isTextDescriptionEnabled = computed(
    () => this._config().text_description_enabled,
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
  // For backward compatibility in templates
  readonly hasTextDescription = this.isTextDescriptionEnabled;

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

  /**
   * Create a project, replacing whatever was open.
   *
   * The close is not optional, for the same reason it is not optional in
   * {@link open}. Creating used to skip it, so a project created while another
   * was open inherited that project's config — its scan pattern, its embed
   * settings, its labels — and every project-scoped service kept the old
   * project's caches. The visible symptoms were a scan that imported nothing
   * and, before that, a missing `embedThresholdKb`.
   *
   * The draft is captured first because `close()` resets project-scoped state,
   * and that includes the labels this form just defined. It is then merged over
   * the defaults, so a field the previous project's file did not carry comes
   * back as a default rather than `undefined`.
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

    // After the project exists, never before: `setDefinitions` reads the labels
    // back with `api.getLabels()`, and the close above left no database for it
    // to read — so the label list came back empty and the instance flags with
    // it.
    await this.labelService.setDefinitions(config);

    this._projectPath.set(path);
    this._isOpen.set(true);

    // Add to recent projects
    this.addToRecentProjects(config.name, path);
  }

  /**
   * Open a project, replacing whatever was open.
   *
   * The close is not optional. Opening used to overwrite the config and labels
   * and nothing else, so a second project inherited the first one's sequences,
   * masks, undo history, gallery filters and per-frame caches — and because ids
   * restart at 1 in every project, those caches did not look stale, they read as
   * the new project's own data.
   */
  async open(path: string): Promise<void> {
    await this.close();
    const config = await api.openProject(path);
    // Merged over the defaults rather than assigned. A project file written by
    // an older version can lack a field the current one expects, and a plain
    // assignment turns that into `undefined` rather than a default — which is
    // how `embed_threshold_kb` went missing and broke the folder scan that
    // follows project creation.
    this._config.set({ ...DEFAULT_PROJECT_CONFIG, ...config });
    await this.labelService.setDefinitions(config); // Now async
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
    // Every service holding project state, not just labels — see
    // `core/project-scoped.ts`. This service is deliberately not in that list:
    // it drives the lifecycle rather than being subject to it.
    this.lifecycle.resetAll();
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
      folderPath: config.input_folder,
      embedImages: config.images_embedded,
      embedThresholdKb: config.embed_threshold_kb,
      inputRegex: config.input_regex,
      recursive: config.recursive,
      foldersAsSequences: config.folders_as_sequences,
    });

    // Update counts after scan
    await this.refreshCounts();

    return result;
  }

  /**
   * Add a folder's images to the open project. See `add_images_to_project` for
   * how images already present, and folders outside the project's own, are
   * handled.
   */
  async addImages(options: ScanOptions): Promise<AddImagesResult> {
    const result = await api.addImagesToProject(options);
    await this.refreshCounts();
    return result;
  }

  // ==========================================
  // Editing an open project
  // ==========================================

  /**
   * Apply one configuration change to the open project.
   *
   * The backend changes the config and the annotations that depend on it in
   * one transaction and hands back the result, which replaces the local copy
   * wholesale: nothing here patches `_config` by hand, so the two cannot
   * disagree about what a half-applied edit looks like.
   *
   * Callers go through `ProjectSettingsService`, which also flushes and drops
   * the editor's in-memory state around the edit. Calling this directly while
   * a frame is loaded leaves that state describing labels that have changed.
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

  // ==========================================
  // Recent Projects (localStorage)
  // ==========================================

  getRecentProjects(): RecentProject[] {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored) as Partial<RecentProject>[];
      // Migration: older entries lack `last_opened`. Fill with 0 so they sort
      // to the bottom but don't crash any consumer.
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
