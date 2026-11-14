import { Component, OnDestroy, OnInit, computed, effect, inject } from '@angular/core';
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
import { InputTextModule } from 'primeng/inputtext';
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
import { NotificationService } from '../../../services/notification.service';
import { api, RegressionConfig } from '../../../lib/api';

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
    InputTextModule,
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
  private notifications = inject(NotificationService);

  public classificationChoices: (string | null)[] = [];
  public multilabelChoices: string[] = [];
  public textContents = new Map<string, string>();

  readonly regressionTasks = computed(
    () => this.projectService.config().regression_tasks ?? [],
  );
  /** The current frame's regression values by task name. Absent or null: not
   *  answered. */
  public regressionValues: Record<string, number | null> = {};
  /** Slider moves waiting to be saved, by task name. */
  private regressionTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    // Only when there is none: this panel can also be opened mid-work, from the
    // label bar.
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

    await this.loadRegressions(frameId);
  }

  private async loadRegressions(frameId: number): Promise<void> {
    const values: Record<string, number | null> = {};
    for (const r of await api.loadRegressions(frameId)) {
      values[r.taskName] = r.value;
    }
    // The frame may have changed while this was loading.
    if (this.currentFrameId === frameId) this.regressionValues = values;
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

  // ── Regression Management ────────────────────────────────────────────────

  /** A value with both bounds is set with a slider. */
  public hasRange(task: RegressionConfig): boolean {
    return task.min != null && task.max != null && task.max > task.min;
  }

  /** One for an integer, else a power of ten giving 100 to 1000 positions. */
  public sliderStep(task: RegressionConfig): number {
    if (task.dtype === 'int32') return 1;
    const range = (task.max ?? 1) - (task.min ?? 0);
    return 10 ** Math.floor(Math.log10(range / 100));
  }

  /** The value as the number field shows it. A float32 is stored as the
   *  nearest single-precision number (0.1 as 0.10000000149...), which seven
   *  significant digits round back to what was entered. */
  public shownValue(task: RegressionConfig): string {
    const value = this.regressionValues[task.name];
    if (value == null) return '';
    return String(task.dtype === 'float32' ? Number(value.toPrecision(7)) : value);
  }

  /** The slider moved: show the value at once, save once it rests. */
  public onRegressionSlide(task: RegressionConfig, value: number | undefined): void {
    const frameId = this.currentFrameId;
    if (!frameId || value === undefined) return;
    this.regressionValues[task.name] = value;
    clearTimeout(this.regressionTimers.get(task.name));
    this.regressionTimers.set(
      task.name,
      setTimeout(() => {
        this.regressionTimers.delete(task.name);
        void this.saveRegression(frameId, task, value);
      }, 250),
    );
  }

  /** The number field was committed. Empty removes the value. */
  public async commitRegression(task: RegressionConfig, input: HTMLInputElement): Promise<void> {
    const frameId = this.currentFrameId;
    if (!frameId) return;
    const text = input.value.trim();
    const value = text === '' ? null : Number(text);
    if (value === null || Number.isFinite(value)) {
      await this.saveRegression(frameId, task, value);
    }
    // What was stored, which may differ from what was typed (rounding, or a
    // refused value).
    if (this.currentFrameId === frameId) input.value = this.shownValue(task);
  }

  public clearRegression(task: RegressionConfig): Promise<void> {
    const frameId = this.currentFrameId;
    if (!frameId) return Promise.resolve();
    return this.saveRegression(frameId, task, null);
  }

  private async saveRegression(
    frameId: number,
    task: RegressionConfig,
    value: number | null,
  ): Promise<void> {
    // A slider move still waiting would overwrite this one.
    clearTimeout(this.regressionTimers.get(task.name));
    this.regressionTimers.delete(task.name);
    try {
      const stored = await api.saveRegression(frameId, task.name, value);
      if (this.currentFrameId === frameId) this.regressionValues[task.name] = stored;
    } catch (error) {
      this.notifications.error(
        `Could not save “${task.name}”`,
        error instanceof Error ? error.message : String(error),
      );
      if (this.currentFrameId === frameId) await this.loadRegressions(frameId);
    }
  }

  // ── Label Tree Management ────────────────────────────────────────────────

  public hasChild(node: TreeNode): boolean {
    return !!(node.children && node.children.length > 0);
  }

  /** The tree node of the active label. */
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

  // ── Canvas Operations ────────────────────────────────────────────────────

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

  public updateOpacity(): void {
    this.editorService.requestCanvasRedraw();
  }
}