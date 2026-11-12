import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { InputNumberModule } from 'primeng/inputnumber';
import { TooltipModule } from 'primeng/tooltip';

import {
  CleanOp,
  InvertMode,
  MaskOpsService,
  MaskOpsTarget,
} from '../../drawable-canvas/service/mask-ops.service';
import { LabelsService } from '../../../../services/labels/labels.service';
import { SequenceService } from '../../../../services/sequence.service';
import { ProjectService } from '../../../../services/project/project.service';
import { IS_ANDROID } from '../../../../core/platform';

interface Choice<T> {
  value: T;
  label: string;
  icon: string;
  hint: string;
}

/** What each clean-up tile shows and which setting it takes. */
interface CleanOpInfo extends Choice<CleanOp> {
  /** The setting under the tiles; none for "Keep largest". */
  param: 'holeArea' | 'islandArea' | 'radius' | 'smoothing' | 'gapWidth' | null;
  /** It can add pixels, so "take from other labels" applies. */
  adds: boolean;
}

/** The Boolean section of the settings panel. */
@Component({
  selector: 'app-mask-ops-panel',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    MultiSelectModule,
    SliderModule,
    ToggleSwitchModule,
    InputNumberModule,
    TooltipModule,
  ],
  templateUrl: './mask-ops-panel.component.html',
  styleUrl: './mask-ops-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.Default,
})
export class MaskOpsPanelComponent {
  readonly ops = inject(MaskOpsService);
  readonly labels = inject(LabelsService);
  readonly project = inject(ProjectService);
  private sequence = inject(SequenceService);
  readonly isAndroid = IS_ANDROID;

  readonly scopes: Choice<boolean>[] = [
    { value: false, label: 'This frame', icon: 'image', hint: 'Only the open frame' },
    {
      value: true,
      label: 'All frames',
      icon: 'burst_mode',
      hint: 'Every frame of the sequence, saved as it goes',
    },
  ];

  readonly invertModes: Choice<InvertMode>[] = [
    {
      value: 'unlabelled',
      label: 'Into free space',
      icon: 'crop_free',
      hint: 'The label takes the pixels no label covers and gives up its own',
    },
    {
      value: 'whole',
      label: 'Whole image',
      icon: 'invert_colors',
      hint: 'The label becomes its exact complement, over other labels too',
    },
  ];

  readonly targets: Choice<MaskOpsTarget>[] = [
    { value: 'active', label: 'Active', icon: 'radio_button_checked', hint: 'The active label' },
    { value: 'all', label: 'All', icon: 'select_all', hint: 'Every label' },
    { value: 'visible', label: 'Visible', icon: 'visibility', hint: 'The labels shown' },
    { value: 'selected', label: 'Pick', icon: 'checklist', hint: 'Labels you pick' },
  ];

  readonly cleanOps: CleanOpInfo[] = [
    {
      value: 'holes',
      label: 'Fill holes',
      icon: 'format_color_fill',
      hint: 'Fill the holes inside each label, up to an area.',
      param: 'holeArea',
      adds: true,
    },
    {
      value: 'islands',
      label: 'Islands',
      icon: 'grain',
      hint: 'Remove the stray pieces up to an area.',
      param: 'islandArea',
      adds: false,
    },
    {
      value: 'largest',
      label: 'Largest',
      icon: 'filter_center_focus',
      hint: 'Keep only the largest piece of each label (of each instance).',
      param: null,
      adds: false,
    },
    {
      value: 'smooth',
      label: 'Smooth',
      icon: 'blur_on',
      hint: 'Round off the outline: bumps and dents narrower than the strength go.',
      param: 'smoothing',
      adds: true,
    },
    {
      value: 'dilate',
      label: 'Dilate',
      icon: 'open_in_full',
      hint: 'Grow each label by the radius.',
      param: 'radius',
      adds: true,
    },
    {
      value: 'erode',
      label: 'Erode',
      icon: 'close_fullscreen',
      hint: 'Shrink each label by the radius.',
      param: 'radius',
      adds: false,
    },
    {
      value: 'gaps',
      label: 'Fill gaps',
      icon: 'join_inner',
      hint: 'Close the gaps between labels that nearly touch; each takes its side. Outer edges do not grow.',
      param: 'gapWidth',
      adds: false,
    },
  ];

  readonly frameCount = computed(() => this.sequence.frames().length);
  readonly selectedOp = computed(
    () => this.cleanOps.find((o) => o.value === this.ops.cleanOp()) ?? this.cleanOps[0],
  );

  get busy(): boolean {
    return this.ops.progress() !== null;
  }

  /** What the clean-up applies to, in words. */
  get targetSummary(): string {
    switch (this.ops.target()) {
      case 'active':
        return this.labels.activeLabel?.label ?? 'no active label';
      case 'all':
        return 'every label';
      case 'visible':
        return 'the visible labels';
      case 'selected': {
        const n = this.ops.selectedLabels().length;
        return n === 1 ? '1 label' : `${n} labels`;
      }
    }
  }

  tip(text: string): string {
    return this.isAndroid ? '' : text;
  }

  apply(): void {
    const op = this.ops.cleanOp();
    void (op === 'gaps' ? this.ops.fillGaps() : this.ops.morph(op));
  }
}
