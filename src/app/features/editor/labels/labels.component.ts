import { Component, OnDestroy, OnInit, effect, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { TreeModule } from 'primeng/tree';
import { ColorPickerModule } from 'primeng/colorpicker';
import { CommonModule } from '@angular/common';
import { SliderModule } from 'primeng/slider';
import { FormsModule } from '@angular/forms';
import { TreeNode } from 'primeng/api';
import { Button } from 'primeng/button';
import { PanelModule } from 'primeng/panel';
import { FieldsetModule } from 'primeng/fieldset';
import { SelectButtonModule } from 'primeng/selectbutton';
import { DividerModule } from 'primeng/divider';
import { TextareaModule } from 'primeng/textarea';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';

import { LabelsService } from '../../../services/labels/labels.service';
import { ClassificationService } from '../../../services/labels/classification.service';
import { ProjectService } from '../../../services/project/project.service';
import { SequenceService } from '../../../services/sequence.service';
import { EditorService } from '../services/editor.service';
import { SegLabel } from '../../../core/interface';
import { InstanceLabelComponent } from './instance-label/instance-label.component';
import { TextLabel } from '../../../core/interface';
import { LabelledSwitchComponent } from '../../../shared/generics/labelled-switch/labelled-switch.component';
import { api } from '../../../lib/api';

@Component({
  selector: 'app-labels',
  imports: [
    TreeModule,
    ColorPickerModule,
    CommonModule,
    FormsModule,
    Button,
    SelectButtonModule,
    SliderModule,
    PanelModule,
    FieldsetModule,
    DividerModule,
    InstanceLabelComponent,
    LabelledSwitchComponent,
    TextareaModule,
    TagModule,
    TooltipModule,
  ],
  templateUrl: './labels.component.html',
  styleUrl: './labels.component.scss',
  standalone: true,
})
export class LabelsComponent implements OnInit, OnDestroy {
  labelsService = inject(LabelsService);
  editorService = inject(EditorService);
  projectService = inject(ProjectService);
  sequenceService = inject(SequenceService);
  private classificationService = inject(ClassificationService);

  public classificationChoices: (string | null)[] = [];
  public multilabelChoices: string[] = [];
  public textContents = new Map<string, string>();

  private destroy$ = new Subject<void>();

  constructor() {
    effect(() => {
      const frame = this.sequenceService.currentFrame();
      if (frame) {
        this.loadFrameData(frame.id);
      }
    });
  }

  ngOnInit(): void {
    // Only when there is none: this panel can also be opened from the label
    // bar, mid-work, and must not put the first label back.
    if (
      !this.labelsService.activeLabel &&
      this.labelsService.listSegmentationLabels.length > 0
    ) {
      this.labelsService.activeLabel = this.labelsService.listSegmentationLabels[0];
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Frame Data Loading ───────────────────────────────────────────────────

  private async loadFrameData(frameId: number): Promise<void> {
    const taskCount = this.labelsService.listClassificationTasks.length;
    await this.classificationService.loadForFrame(frameId, taskCount);
    
    this.classificationChoices = this.classificationService.getMulticlassChoices(frameId);
    this.multilabelChoices = this.classificationService.getMultilabelChoices(frameId);

    const textData = await api.loadTextDescriptions(frameId);
    this.textContents.clear();
    for (const t of textData) {
      this.textContents.set(t.fieldName, t.content);
    }
    
    for (const label of this.labelsService.listTextLabels) {
      label.content = this.textContents.get(label.name) ?? '';
    }
  }

  // ── Classification Management ────────────────────────────────────────────

  private get currentFrameId(): number | null {
    return this.sequenceService.currentFrame()?.id ?? null;
  }

  public async setMulticlassValue(taskIndex: number, value: string): Promise<void> {
    const frameId = this.currentFrameId;
    if (!frameId) return;

    this.classificationChoices[taskIndex] = value;
    this.classificationService.setMulticlassChoice(frameId, taskIndex, value);

    const task = this.labelsService.listClassificationTasks[taskIndex];
    await this.classificationService.saveMulticlass(frameId, task.taskName, value);
  }

  public async onMultilabelChange(): Promise<void> {
    const frameId = this.currentFrameId;
    if (!frameId || !this.labelsService.multiLabelTask) return;

    this.classificationService.setMultilabelChoices(frameId, this.multilabelChoices);
    await this.classificationService.saveMultilabel(
      frameId,
      this.labelsService.multiLabelTask.taskName,
      this.multilabelChoices
    );
  }

  public async removeChoiceFromMultilabel(choice: string): Promise<void> {
    this.multilabelChoices = this.multilabelChoices.filter(v => v !== choice);
    await this.onMultilabelChange();
  }

  // ── Text Description Management ──────────────────────────────────────────

  public async onTextChange(label: TextLabel): Promise<void> {
    const frameId = this.currentFrameId;
    if (!frameId) return;

    this.textContents.set(label.name, label.content);
    await api.saveTextDescription(frameId, label.name, label.content);
  }

  // ── Label Tree Management (unchanged) ────────────────────────────────────

  public hasChild(node: TreeNode): boolean {
    return !!(node.children && node.children.length > 0);
  }

  /**
   * The tree node backing the active label, so the tree's selection highlight
   * always tracks `activeLabel` — whether it changed by click or by Ctrl+Tab.
   * This is the single source of truth; there is no separate "last clicked".
   */
  get selectedTreeNode(): TreeNode | null {
    const active = this.labelsService.activeLabel;
    return active ? this.findNode(this.labelsService.getTreeNode(), active) : null;
  }

  private findNode(nodes: TreeNode[], label: SegLabel): TreeNode | null {
    for (const node of nodes) {
      if (node.data === label) return node;
      if (node.children) {
        const found = this.findNode(node.children, label);
        if (found) return found;
      }
    }
    return null;
  }

  public changeActiveLabel(event: TreeNode[] | TreeNode | null): void {
    if (Array.isArray(event) || !event) return;

    this.labelsService.activate(event.data as SegLabel);
  }

  // ── Canvas Operations (unchanged) ────────────────────────────────────────

  public clearCanvas(node: TreeNode): void {
    const label = node.data as SegLabel;
    const index = this.labelsService.listSegmentationLabels.indexOf(label);
    if (index !== -1) {
      this.editorService.requestCanvasClear(index);
    }
  }

  /** Erase every label on this frame. Undoable as one step. */
  public clearFrame(): void {
    this.editorService.requestCanvasClear();
  }

  public changeVisibility(node: TreeNode): void {
    const label = node.data as SegLabel;
    label.isVisible = !label.isVisible;
    this.editorService.requestCanvasRedraw();
  }

  public changeColor(): void {
    this.editorService.requestCanvasRedraw();
  }

  public changeAllVisibility(): void {
    this.labelsService.switchVisibilityAllSegLabels();
    this.editorService.requestCanvasRedraw();
  }

  public updateOpacity(): void {
    this.editorService.requestCanvasRedraw();
  }
}