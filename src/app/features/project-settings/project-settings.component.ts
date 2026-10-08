import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';

import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { ColorPickerModule } from 'primeng/colorpicker';
import { DialogModule } from 'primeng/dialog';
import { FieldsetModule } from 'primeng/fieldset';
import { InputTextModule } from 'primeng/inputtext';
import { ProgressBarModule } from 'primeng/progressbar';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';

import { AddImagesResult, EditImpact, ProjectEdit, TaskKind } from '../../lib/api';
import { SegLabel } from '../../core/interface';
import { getDefaultColor } from '../../core/misc/colors';
import { LabelsService } from '../../services/labels/labels.service';
import { NotificationService } from '../../services/notification.service';
import { ProjectService } from '../../services/project/project.service';
import { LabelledSwitchComponent } from '../../shared/generics/labelled-switch/labelled-switch.component';
import { FolderDropZoneComponent } from '../launcher/folder-drop-zone/folder-drop-zone.component';
import { ProjectSettingsService } from './project-settings.service';

/** A destructive edit waiting for the user to acknowledge what it deletes. */
interface PendingDelete {
  edit: ProjectEdit;
  title: string;
  /** One sentence per thing that will be lost. */
  consequences: string[];
  resolve: (confirmed: boolean) => void;
}

/** A classification task as the page lists it, multiclass or multilabel. */
interface TaskRow {
  name: string;
  classes: string[];
  multilabel: boolean;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Edit the configuration of the open project: its name, images, labels and
 * tasks.
 *
 * Every control applies its change immediately — there is no draft and no Save
 * button. A change is one `ProjectEdit`, written to the project file in a
 * single transaction, so the page never holds a state the file does not. The
 * exception is a deletion that would erase annotations: that one stops at a
 * dialog spelling out what will be lost, and needs an explicit acknowledgment.
 */
@Component({
  selector: 'app-project-settings',
  imports: [
    CommonModule,
    FormsModule,
    DragDropModule,
    ButtonModule,
    CheckboxModule,
    ColorPickerModule,
    DialogModule,
    FieldsetModule,
    InputTextModule,
    ProgressBarModule,
    TagModule,
    TooltipModule,
    LabelledSwitchComponent,
    FolderDropZoneComponent,
  ],
  templateUrl: './project-settings.component.html',
  styleUrl: './project-settings.component.scss',
})
export class ProjectSettingsComponent {
  readonly project = inject(ProjectService);
  private readonly settings = inject(ProjectSettingsService);
  private readonly labelsService = inject(LabelsService);
  private readonly notifications = inject(NotificationService);

  readonly config = this.project.config;

  /** True while an edit is being written. Only buttons react to it: disabling
   *  a text field would throw the focus out of the one the user just tabbed
   *  into, since leaving a field is what commits it. */
  readonly busy = signal(false);

  /** Edits run one after the other, in the order they were made. Tabbing out
   *  of one field straight into a click must apply both, not drop the second. */
  private queue: Promise<unknown> = Promise.resolve();

  // ── Labels ────────────────────────────────────────────────────────────────

  /** Snapshot of the label list. `LabelsService` keeps a plain array that it
   *  replaces after every edit, so the page re-reads it rather than binding. */
  readonly labels = signal<SegLabel[]>([...this.labelsService.listSegmentationLabels]);

  /** Colours picked but not yet written, by label id (committed when the
   *  picker closes, so dragging through the palette is one edit, not fifty). */
  private readonly draftColors = new Map<number, string>();

  // ── Tasks ─────────────────────────────────────────────────────────────────

  readonly tasks = computed<TaskRow[]>(() => {
    const config = this.config();
    const rows: TaskRow[] = (config.classification_tasks ?? []).map((t) => ({
      name: t.name,
      classes: t.classes,
      multilabel: false,
    }));
    if (config.multilabel_task) {
      rows.push({
        name: config.multilabel_task.name,
        classes: config.multilabel_task.classes,
        multilabel: true,
      });
    }
    return rows;
  });

  readonly hasMultilabelTask = computed(() => !!this.config().multilabel_task);
  readonly textFields = computed(() => this.config().text_fields ?? []);

  // ── Destructive-edit confirmation ─────────────────────────────────────────

  readonly pending = signal<PendingDelete | null>(null);
  /** The "I understand" checkbox; reset for every dialog. */
  acknowledged = false;

  // ── Adding images ─────────────────────────────────────────────────────────

  readonly addFolder = signal<string | null>(null);
  addRegex = this.config().input_regex;
  addRecursive = this.config().recursive;
  addFoldersAsSequences = this.config().folders_as_sequences;
  addEmbed = this.config().images_embedded;
  /** Keep one frame out of this many from each added video. */
  addVideoFrameStep = 1;
  readonly adding = signal(false);
  readonly lastImport = signal<AddImagesResult | null>(null);

  /**
   * Whether the chosen folder lies outside the project's image folder, in
   * which case its images can only be embedded. A plain path comparison: the
   * backend makes the real decision (it resolves symlinks), this only decides
   * what the page says beforehand.
   */
  readonly addFolderIsOutside = computed(() => {
    const folder = this.addFolder();
    if (!folder) return false;
    const root = this.config().input_folder;
    if (!root) return true;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const f = norm(folder);
    const r = norm(root);
    return f !== r && !f.startsWith(r + '/');
  });

  // ==========================================
  // Project
  // ==========================================

  async renameProject(input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (name !== this.config().name) {
      await this.run({ type: 'renameProject', name });
    }
    input.value = this.config().name;
  }

  // ==========================================
  // Labels
  // ==========================================

  async addLabel(): Promise<void> {
    const taken = this.labels().map((l) => l.label);
    await this.run({
      type: 'addLabel',
      name: this.freeName('Class', taken),
      color: getDefaultColor(taken.length + 1),
    });
  }

  async renameLabel(label: SegLabel, input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (name !== label.label) {
      await this.run({ type: 'renameLabel', id: label.id, name });
    }
    // On a refused rename the list is unchanged, so the binding would not put
    // the old name back by itself.
    input.value = this.labels().find((l) => l.id === label.id)?.label ?? name;
  }

  async reorderLabels(event: CdkDragDrop<unknown>): Promise<void> {
    if (event.previousIndex === event.currentIndex) return;
    const labels = [...this.labels()];
    moveItemInArray(labels, event.previousIndex, event.currentIndex);
    // Shown at once so the row stays where it was dropped; `run` re-reads the
    // real list afterwards, which puts it back if the edit was refused.
    this.labels.set(labels);
    await this.run({ type: 'reorderLabels', ids: labels.map((l) => l.id) });
  }

  colorOf(label: SegLabel): string {
    return this.draftColors.get(label.id) ?? label.color;
  }

  draftColor(label: SegLabel, color: string): void {
    this.draftColors.set(label.id, color);
  }

  async commitColor(label: SegLabel): Promise<void> {
    const color = this.draftColors.get(label.id);
    this.draftColors.delete(label.id);
    if (!color || color.toLowerCase() === label.color.toLowerCase()) return;
    await this.run({ type: 'recolorLabel', id: label.id, color });
  }

  deleteLabel(label: SegLabel): Promise<void> {
    return this.runDestructive(
      { type: 'deleteLabel', id: label.id },
      `Delete the label “${label.label}”?`,
      (impact) => [
        impact.maskFrames > 0 &&
          `Its painted masks on ${plural(impact.maskFrames, 'frame')} will be erased.`,
        impact.shapeFrames > 0 &&
          `Its vector shapes on ${plural(impact.shapeFrames, 'frame')} will be erased.`,
        impact.discardsModel &&
          'The trained segmentation model predicts this label and will be discarded. It will have to be trained again.',
      ],
    );
  }

  // ==========================================
  // Tasks
  // ==========================================

  setTaskEnabled(task: TaskKind, enabled: boolean): Promise<boolean> {
    return this.run({ type: 'setTaskEnabled', task, enabled });
  }

  addMulticlassTask(): Promise<boolean> {
    return this.run({ type: 'addMulticlassTask', name: this.freeTaskName('Task') });
  }

  addMultilabelTask(): Promise<boolean> {
    return this.run({ type: 'addMultilabelTask', name: this.freeTaskName('Multilabel') });
  }

  async renameTask(task: TaskRow, input: HTMLInputElement): Promise<void> {
    const newName = input.value.trim();
    let renamed = false;
    if (newName !== task.name) {
      renamed = await this.run({ type: 'renameTask', name: task.name, newName });
    }
    if (!renamed) input.value = task.name;
  }

  deleteTask(task: TaskRow): Promise<void> {
    return this.runDestructive(
      { type: 'deleteTask', name: task.name },
      `Delete the task “${task.name}”?`,
      (impact) => [
        impact.classificationFrames > 0 &&
          `The answers given for it on ${plural(impact.classificationFrames, 'frame')} will be erased.`,
      ],
    );
  }

  addClass(task: TaskRow): Promise<boolean> {
    return this.run({
      type: 'addClass',
      task: task.name,
      name: this.freeName('Class', task.classes),
    });
  }

  async renameClass(task: TaskRow, name: string, input: HTMLInputElement): Promise<void> {
    const newName = input.value.trim();
    let renamed = false;
    if (newName !== name) {
      renamed = await this.run({ type: 'renameClass', task: task.name, name, newName });
    }
    if (!renamed) input.value = name;
  }

  deleteClass(task: TaskRow, name: string): Promise<void> {
    return this.runDestructive(
      { type: 'deleteClass', task: task.name, name },
      `Delete the class “${name}” of “${task.name}”?`,
      (impact) => [
        impact.classificationFrames > 0 &&
          (task.multilabel
            ? `It will be unselected on the ${plural(impact.classificationFrames, 'frame')} that carry it.`
            : `The ${plural(impact.classificationFrames, 'frame')} classified as “${name}” will go back to unclassified.`),
      ],
    );
  }

  // ==========================================
  // Text fields
  // ==========================================

  addTextField(): Promise<boolean> {
    return this.run({
      type: 'addTextField',
      name: this.freeName('Field', this.textFields()),
    });
  }

  async renameTextField(name: string, input: HTMLInputElement): Promise<void> {
    const newName = input.value.trim();
    let renamed = false;
    if (newName !== name) {
      renamed = await this.run({ type: 'renameTextField', name, newName });
    }
    if (!renamed) input.value = name;
  }

  deleteTextField(name: string): Promise<void> {
    return this.runDestructive(
      { type: 'deleteTextField', name },
      `Delete the text field “${name}”?`,
      (impact) => [
        impact.textFrames > 0 &&
          `The text written in it on ${plural(impact.textFrames, 'frame')} will be erased.`,
      ],
    );
  }

  // ==========================================
  // Images
  // ==========================================

  onAddFolderChange(path: string): void {
    this.addFolder.set(path || null);
    this.lastImport.set(null);
  }

  async addImages(): Promise<void> {
    const folder = this.addFolder();
    if (!folder || this.adding()) return;

    this.adding.set(true);
    try {
      const result = await this.settings.addImages({
        folderPath: folder,
        embedImages: this.addEmbed || this.addFolderIsOutside(),
        embedThresholdKb: this.config().embed_threshold_kb,
        inputRegex: this.addRegex,
        recursive: this.addRecursive,
        foldersAsSequences: this.addFoldersAsSequences,
        videoFrameStep: Math.max(1, Math.floor(Number(this.addVideoFrameStep)) || 1),
      });
      this.lastImport.set(result);
      if (result.framesImported > 0) {
        this.notifications.success(
          'Images added',
          `${plural(result.framesImported, 'image')} in ${plural(result.sequencesCreated, 'new sequence')}`,
        );
      } else if (result.errors.length === 0) {
        this.notifications.info(
          'Nothing to add',
          result.framesSkipped > 0
            ? 'Every matching image is already in the project.'
            : 'No file in this folder matches the filename pattern.',
        );
      }
    } catch (error) {
      this.notifications.error('Could not add images', String(error));
    } finally {
      this.adding.set(false);
    }
  }

  // ==========================================
  // Confirmation dialog
  // ==========================================

  answer(confirmed: boolean): void {
    this.pending()?.resolve(confirmed);
  }

  // ==========================================
  // Internals
  // ==========================================

  /** Apply one edit. Returns whether it went through; a failure is reported. */
  private run(edit: ProjectEdit): Promise<boolean> {
    const result = this.queue.then(() => this.execute(edit));
    this.queue = result;
    return result;
  }

  /** Never rejects, so one failed edit does not poison the queue. */
  private async execute(edit: ProjectEdit): Promise<boolean> {
    this.busy.set(true);
    try {
      await this.settings.apply(edit);
      return true;
    } catch (error) {
      this.notifications.error('Could not change the project', this.message(error));
      return false;
    } finally {
      this.labels.set([...this.labelsService.listSegmentationLabels]);
      this.busy.set(false);
    }
  }

  /**
   * Apply a deletion, asking first when it would erase annotations.
   *
   * Deleting something nothing was ever annotated with loses nothing and can
   * be recreated in a click, so it goes straight through: a confirmation on
   * every delete is how people learn to click through the one that matters.
   */
  private async runDestructive(
    edit: ProjectEdit,
    title: string,
    describe: (impact: EditImpact) => (string | false)[],
  ): Promise<void> {
    // Let edits already under way land first, so the count is of what is
    // really there.
    await this.queue;
    if (this.pending()) return;

    let consequences: string[];
    try {
      const impact = await this.settings.impact(edit);
      consequences = describe(impact).filter((line): line is string => !!line);
    } catch (error) {
      this.notifications.error('Could not change the project', this.message(error));
      return;
    }

    if (consequences.length > 0) {
      this.acknowledged = false;
      const confirmed = await new Promise<boolean>((resolve) =>
        this.pending.set({ edit, title, consequences, resolve }),
      );
      this.pending.set(null);
      if (!confirmed) return;
    }
    await this.run(edit);
  }

  private freeTaskName(base: string): string {
    return this.freeName(
      base,
      this.tasks().map((t) => t.name),
    );
  }

  /** `base N`, for the first N past the current count that is not in `taken`. */
  private freeName(base: string, taken: readonly string[]): string {
    for (let n = taken.length + 1; ; n++) {
      const candidate = `${base} ${n}`;
      if (!taken.includes(candidate)) return candidate;
    }
  }

  /** Tauri rejects with the backend's message as a plain string. */
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
