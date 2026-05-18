import { Injectable } from '@angular/core';
import { SegInstance, SegLabel } from '../../Core/interface';
import { constructLabelTreeNode } from './labelTreeNode';
import { TreeNode } from 'primeng/api';
import { MulticlassTask, MultilabelTask } from '../../Core/task';
import {TextLabel} from "../../Core/interface";
import { api, ProjectConfig } from '../../lib/api';
@Injectable({
  providedIn: 'root',
})
export class LabelsService {
  listSegmentationLabels: SegLabel[] = [];

  listClassificationTasks: MulticlassTask[] = [];

  listTextLabels: TextLabel[] = [];

  multiLabelTask: MultilabelTask | null = null;

  private _treeNode: TreeNode[] | null = null;
  activeLabel: SegLabel | null = null;

  activeSegInstance: SegInstance | null = null;
  showAllLabels: boolean = true;

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
    // Only add label if it does not already exist in the list
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
      this.activeSegInstance = {
        label: this.activeLabel,
        instance: 1,
        shade: '',
        id: this.activeLabel.id,
      };
    } else {
      let current_instance = this.activeSegInstance.instance;
      if (current_instance >= this.activeLabel.shades!.length - 1) {
        current_instance = -1;
      }
      current_instance++;
      let new_shade = this.activeLabel.shades![current_instance];

      this.activeSegInstance = {
        label: this.activeLabel,
        instance: current_instance,
        shade: new_shade,
        id: this.activeLabel.id,
      };
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

  private generateShades(baseColor: string, count: number = 10): string[] {
    // Generate instance shades from base color
    // Implement based on your existing shade logic
    return [baseColor]; // placeholder
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

    for (const label of dbLabels) {
      this.addSegLabel({
        id: label.id,
        label: label.name,
        color: label.color,
        isVisible: true,
        shades: label.isInstance ? this.generateShades(label.color) : null,
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
}
