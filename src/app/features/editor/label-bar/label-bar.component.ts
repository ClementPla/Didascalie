import { Component, inject, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { PopoverModule } from 'primeng/popover';
import { SliderModule } from 'primeng/slider';
import { ToggleButtonModule } from 'primeng/togglebutton';

import { SegLabel } from '../../../core/interface';
import { LabelsService } from '../../../services/labels/labels.service';
import { ProjectService } from '../../../services/project/project.service';
import { SequenceService } from '../../../services/sequence.service';
import { InstanceLabelComponent } from '../labels/instance-label/instance-label.component';
import { LabelsComponent } from '../labels/labels.component';
import { SequenceNavigatorComponent } from '../sequence-navigator/sequence-navigator.component';
import { EditorService } from '../services/editor.service';

/**
 * The labels as a horizontal bar above the canvas, for a narrow portrait
 * screen where the side panel would leave the canvas half the width.
 *
 * It holds what is reached for while drawing: which label, which instance, what
 * is visible. Everything else the side panel offers (classification, text
 * fields, colours) and the sequence list open from it as popovers, showing the
 * very same components, so nothing exists in two versions.
 *
 * Not OnPush: the label state it reads lives in plain fields on
 * `LabelsService`, which the canvas and the shortcuts change as well.
 */
@Component({
  selector: 'app-label-bar',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    PopoverModule,
    SliderModule,
    ToggleButtonModule,
    InstanceLabelComponent,
    LabelsComponent,
    SequenceNavigatorComponent,
  ],
  templateUrl: './label-bar.component.html',
  styleUrl: './label-bar.component.scss',
})
export class LabelBarComponent {
  readonly labels = inject(LabelsService);
  readonly editor = inject(EditorService);
  readonly project = inject(ProjectService);
  private readonly sequences = inject(SequenceService);

  readonly sequenceSelected = output<number>();

  get hasSegmentation(): boolean {
    return this.project.isSegmentation() || this.project.isInstanceSegmentation();
  }

  get hasSeveralSequences(): boolean {
    return this.sequences.sequences().length > 1;
  }

  activate(label: SegLabel): void {
    this.labels.activate(label);
  }

  toggleVisibility(label: SegLabel): void {
    label.isVisible = !label.isVisible;
    this.editor.requestCanvasRedraw();
  }

  toggleAllVisibility(): void {
    this.labels.switchVisibilityAllSegLabels();
    this.editor.requestCanvasRedraw();
  }

  /** Erase the active label on this frame. Undoable. */
  clearActive(): void {
    const active = this.labels.activeLabel;
    const index = active ? this.labels.listSegmentationLabels.indexOf(active) : -1;
    if (index !== -1) this.editor.requestCanvasClear(index);
  }
}
