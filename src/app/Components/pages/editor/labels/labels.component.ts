// labels.component.ts
import { ChangeDetectorRef, Component, OnDestroy, OnInit } from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
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

import { LabelsService } from '../../../../Services/Labels/labels.service';
import { ClassificationService } from '../../../../Services/Labels/classification.service';
import { ProjectService } from '../../../../Services/ProjectService/project.service';
import { NavigationService } from '../../../../Services/Navigation/navigation.service';
import { EditorService } from '../services/editor.service';
import { SegLabel } from '../../../../Core/interface';
import { InstanceLabelComponent } from './instance-label/instance-label.component';

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
    TextareaModule,
    TagModule,
  ],
  templateUrl: './labels.component.html',
  styleUrl: './labels.component.scss'
})
export class LabelsComponent implements OnInit, OnDestroy {
  public classificationChoices: Array<string | null> = [];
  
  private destroy$ = new Subject<void>();

  constructor(
    public labelsService: LabelsService,
    public editorService: EditorService,
    public projectService: ProjectService,
    public classificationService: ClassificationService,
    private navigationService: NavigationService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    // Subscribe to navigation progress to detect when image changes
    this.navigationService.progress$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.bindCurrentClassificationChoices();
      });

    // Set initial active label
    if (this.labelsService.listSegmentationLabels.length > 0) {
      this.labelsService.activeLabel = this.labelsService.listSegmentationLabels[0];
    }

    // Initialize classification choices for current image
    this.bindCurrentClassificationChoices();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Bind classification choices for the currently active image.
   */
  private bindCurrentClassificationChoices(): void {
    this.classificationChoices = this.getMulticlassValues();
    this.cdr.detectChanges();
  }

  // ==========================================
  // Label Tree Management
  // ==========================================

  public hasChild(node: TreeNode): boolean {
    return !!(node.children && node.children.length > 0);
  }

  public changeActiveLabel(event: TreeNode[] | TreeNode | null): void {
    // Handle array or null case
    if (Array.isArray(event) || !event) {
      return;
    }

    // Set active label and instance
    this.labelsService.activeLabel = event.data as SegLabel;
    this.labelsService.activeSegInstance = {
      label: this.labelsService.activeLabel,
      instance: -1,
      shade: this.labelsService.activeLabel.color,
    };
  }

  // ==========================================
  // Canvas Operations
  // ==========================================

  public clearCanvas(node: TreeNode): void {
    const label = node.data as SegLabel;
    const index = this.labelsService.listSegmentationLabels.indexOf(label);
    
    if (index !== -1) {
      this.editorService.requestCanvasClear(index);
    }
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

  // ==========================================
  // Classification Management
  // ==========================================

  public removeChoiceFromMultilabel(choice: string): void {
    this.multilabelValues = this.multilabelValues.filter(
      (value) => value !== choice
    );
  }

  public set multilabelValues(values: string[]) {
    const activeIndex = this.projectService.activeIndex;
    if (activeIndex === null) {
      return;
    }

    const imageName = this.projectService.imagesName[activeIndex];
    this.classificationService.multilabelChoices.set(imageName, values);
  }

  public get multilabelValues(): string[] {
    const activeIndex = this.projectService.activeIndex;
    if (activeIndex === null) {
      return [];
    }

    const imageName = this.projectService.imagesName[activeIndex];
    return this.classificationService.multilabelChoices.get(imageName) || [];
  }

  public getMulticlassValues(): Array<string | null> {
    const activeIndex = this.projectService.activeIndex;
    if (activeIndex === null) {
      return [];
    }

    const imageName = this.projectService.imagesName[activeIndex];
    return this.classificationService.multiclassChoices.get(imageName) || [];
  }

  public setMulticlassValues(taskIndex: number, value: string): void {
    const activeIndex = this.projectService.activeIndex;
    if (activeIndex === null) {
      return;
    }

    const imageName = this.projectService.imagesName[activeIndex];
    const choices = this.classificationService.multiclassChoices.get(imageName);
    
    if (choices) {
      choices[taskIndex] = value;
    }
  }
}