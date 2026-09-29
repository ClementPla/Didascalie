import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { SegInstance, SegLabel } from '../../core/interface';
import { constructLabelTreeNode } from './labelTreeNode';
import { TreeNode } from 'primeng/api';
import { MulticlassTask, MultilabelTask } from '../../core/task';
import {TextLabel} from "../../core/interface";
import { api, ProjectConfig } from '../../lib/api';
import { generate_shades } from '../../core/misc/colors';
import { ProjectScoped } from '../../core/project-scoped';
@Injectable({
  providedIn: 'root',
})
export class LabelsService implements ProjectScoped {
  listSegmentationLabels: SegLabel[] = [];

  listClassificationTasks: MulticlassTask[] = [];

  listTextLabels: TextLabel[] = [];

  multiLabelTask: MultilabelTask | null = null;

  private _treeNode: TreeNode[] | null = null;

  private _activeLabel: SegLabel | null = null;
  /** Emits when the active segmentation label changes (by reference). Lets the
   *  vector editor continue a path across a mid-trace label switch. */
  readonly activeLabelChanged$ = new Subject<SegLabel | null>();

  get activeLabel(): SegLabel | null {
    return this._activeLabel;
  }
  set activeLabel(label: SegLabel | null) {
    if (this._activeLabel === label) return;
    this._activeLabel = label;
    this.activeLabelChanged$.next(label);
  }

  activeSegInstance: SegInstance | null = null;
  showAllLabels = true;

  maxID = 0;

  constructor() {}

  generateNewSegLabelID(): number {
    this.maxID += 1;
    return this.maxID;
  }

  addClassificationTask(task: MulticlassTask) {
    if (
      this.listClassificationTasks.find((t) => t.taskName === task.taskName)
    ) {
      return;
    }

    this.listClassificationTasks.push(task);
  }

  addMultilabelTask(task: MultilabelTask) {
    if (this.multiLabelTask) {
      task.taskLabels.forEach((label) => {
        if (!this.multiLabelTask!.taskLabels.find((l) => l === label)) {
          this.multiLabelTask!.taskLabels.push(label);
        }
      });

      return;
    }

    this.multiLabelTask = task;
  }

  addNewClassificationTask() {
    const classTask = new MulticlassTask(
      'Task ' + (this.listClassificationTasks.length + 1),
      []
    );
    this.listClassificationTasks.push(classTask);
  }

  removeClassificationTask(task: MulticlassTask) {
    this.listClassificationTasks = this.listClassificationTasks.filter(
      (t) => t.taskName !== task.taskName
    );
  }

  addSegLabel(label: SegLabel) {
    if (this.listSegmentationLabels.find((l) => l.label === label.label)) {
      return;
    }

    this.listSegmentationLabels.push(label);
    if (!this.activeLabel) {
      this.activeLabel = label;
    }
  }

  addTextLabel(label: TextLabel) {
    if (this.listTextLabels.find((l) => l.name === label.name)) {
      return;
    }

    this.listTextLabels.push(label);
  }

  removeTextLabel(label: TextLabel) {
    this.listTextLabels = this.listTextLabels.filter(
      (l) => l.name !== label.name
    );
  }

  setActiveIndex(index: number) {
    if (index >= 0 && index < this.listSegmentationLabels.length) {
      this.activeLabel = this.listSegmentationLabels[index];
    }
  }
  removeSegLabel(SegLabel: SegLabel) {
    // Check if current active label is the one being removed
    if (this.activeLabel && this.activeLabel.label === SegLabel.label) {
      this.activeLabel = null;
    }
    this.listSegmentationLabels = this.listSegmentationLabels.filter(
      (label) => label.label !== SegLabel.label
    );
    this._treeNode = constructLabelTreeNode(this.listSegmentationLabels);
  }

  /**
   * Make `label` the active one, together with its instance state.
   *
   * The single entry point for changing the active label. The label tree, the
   * keyboard cycle, the instance picker and vector selection all route through
   * here, so `activeLabel` and `activeSegInstance` cannot drift apart — they
   * were set as a pair in four separate places, and any new caller that forgot
   * the second half left the instance picker pointing at the previous label.
   *
   * `instance` defaults to -1, meaning the label as a whole rather than one of
   * its instances.
   */
  activate(label: SegLabel, instance = -1, shade = label.color): void {
    this.activeLabel = label;
    this.activeSegInstance = { label, instance, shade, id: label.id };
  }

  /** Activate the label carrying `id`, if the project still has one. */
  activateById(id: number): void {
    const label = this.listSegmentationLabels.find((l) => l.id === id);
    if (label) this.activate(label);
  }

  /** Move the active label `step` places through the list, wrapping. */
  cycleActive(step: number): void {
    const labels = this.listSegmentationLabels;
    const n = labels.length;
    if (n === 0) return;
    const from = this.getActiveIndex();
    if (from < 0) {
      // Nothing active yet — enter the list from whichever end `step` implies.
      this.activate(labels[step > 0 ? 0 : n - 1]);
      return;
    }
    this.activate(labels[(((from + step) % n) + n) % n]);
  }

  getActiveIndex(): number {
    if (this.activeLabel) {
      return this.listSegmentationLabels.findIndex(
        (label) => label.label === this.activeLabel!.label
      );
    }
    return -1;
  }

  getTreeNode(): TreeNode[] {
    if (!this._treeNode) {
      this._treeNode = constructLabelTreeNode(this.listSegmentationLabels);
    }

    return this._treeNode;
  }

  rebuildTreeNodes() {
    this._treeNode = constructLabelTreeNode(this.listSegmentationLabels);
  }

  switchVisibilityAllSegLabels() {
    this.showAllLabels = !this.showAllLabels;
    this.listSegmentationLabels.forEach((label) => {
      label.isVisible = this.showAllLabels;
    });
  }

  incrementActiveInstance() {
    if (!this.activeLabel) {
      return;
    }
    if (!this.activeSegInstance) {
      this.activate(
        this.activeLabel,
        1,
        this.activeLabel.shades?.[1] ?? this.activeLabel.color,
      );
    } else {
      let current_instance = this.activeSegInstance.instance;
      // Instance ids are the pixel value, so they must stay >= 1 (0 = empty).
      // Wrap back to 1, never 0, so ids never collide at paint time.
      if (current_instance >= this.activeLabel.shades!.length - 1) {
        current_instance = 0;
      }
      current_instance++;
      this.activate(
        this.activeLabel,
        current_instance,
        this.activeLabel.shades![current_instance],
      );
    }
  }

  resetAll() {
    this.listSegmentationLabels = [];
    this.listClassificationTasks = [];
    this.listTextLabels = [];
    this.multiLabelTask = null;
    this._treeNode = null;
    this.activeLabel = null;
    this.activeSegInstance = null;
    this.showAllLabels = true;
    this.maxID = 0;
  }

  private generateShades(baseColor: string, count = 256): string[] {
    // One deterministic shade per possible instance id (pixel value 1..255), so
    // an instance always displays the same colour. Index 0 is unused (0 = bg).
    return generate_shades(baseColor, count);
  }
  getDefinitions(): Pick<
    ProjectConfig,
    | 'segmentation_labels'
    | 'classification_tasks'
    | 'multilabel_task'
    | 'text_fields'
  > {
    return {
      segmentation_labels: this.listSegmentationLabels.map((l) => ({
        name: l.label,
        color: l.color,
        shades: l.shades ?? undefined,
        id: l.id,
      })),
      classification_tasks: this.listClassificationTasks.map((t) => ({
        name: t.taskName,
        classes: t.classLabels,
      })),
      multilabel_task: this.multiLabelTask
        ? {
            name: this.multiLabelTask.taskName,
            classes: this.multiLabelTask.taskLabels,
          }
        : undefined,
      text_fields: this.listTextLabels.map((l) => l.name),
    };
  }

  async setDefinitions(config: ProjectConfig): Promise<void> {
    this.resetAll();
    
    // Load labels from database (includes IDs)
    const dbLabels = await api.getLabels();
    console.log('API returned labels:', dbLabels);
    console.log('Loaded labels from DB:', dbLabels);

    // The project flag is checked alongside the per-label one so the palette is
    // right even against a database whose `is_instance` column was written by a
    // build that derived it from the presence of `shades`.
    const instanceProject = config.instance_segmentation_enabled === true;

    for (const label of dbLabels) {
      this.addSegLabel({
        id: label.id,
        label: label.name,
        color: label.color,
        isVisible: true,
        shades:
          label.isInstance || instanceProject
            ? this.generateShades(label.color)
            : null,
      });
    }

    // Load classification tasks from config
    for (const task of config.classification_tasks ?? []) {
      this.addClassificationTask(new MulticlassTask(task.name, task.classes));
    }

    if (config.multilabel_task) {
      this.addMultilabelTask(
        new MultilabelTask(
          config.multilabel_task.name,
          config.multilabel_task.classes
        )
      );
    }

    for (const name of config.text_fields ?? []) {
      this.addTextLabel({ name: name, content: '' });
    }

    this.rebuildTreeNodes();
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.resetAll();
  }
}
