import { Injectable } from '@angular/core';
import { SegInstance, SegLabel, TextLabel } from '../../Core/interface';
import { constructLabelTreeNode } from './labelTreeNode';
import { TreeNode } from 'primeng/api';
import { MulticlassTask, MultilabelTask } from '../../Core/task';
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

  constructor() { }

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
      };
    }
  }
}
