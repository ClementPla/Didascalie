import {
  ChangeDetectionStrategy,
  Component,
  WritableSignal,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { MultiSelectModule } from 'primeng/multiselect';
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
import {
  SizeDialComponent,
  SizeDialMode,
} from '../../../../shared/generics/size-dial/size-dial.component';

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

/** What can be done to the active label. */
type LabelAction = 'invert' | 'cut';

type CleanParam = NonNullable<CleanOpInfo['param']>;

/** How a clean-up setting is picked on the size dial. */
interface ParamDial {
  value: WritableSignal<number>;
  label: string;
  aria: string;
  mode: SizeDialMode;
  min: number;
  /** The dial's outer ring. */
  max: number;
  /** The most the number field takes; above the dial's ring for areas. */
  exactMax: number;
  /** Where the dial's scale turns logarithmic, giving small values room. */
  knee: number;
  step: number;
  unit: string;
  zeroLabel: string | null;
  aside: string | null;
}

/** The Boolean section of the settings panel. */
@Component({
  selector: 'app-mask-ops-panel',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    MultiSelectModule,
    ToggleSwitchModule,
    InputNumberModule,
    TooltipModule,
    SizeDialComponent,
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
  /** The active label, as a signal: the settings panel is OnPush, so reading
   *  the service's plain property would not refresh when it changes. */
  readonly activeLabel = toSignal(this.labels.activeLabelChanged$, {
    initialValue: this.labels.activeLabel,
  });

  readonly scopes: Choice<boolean>[] = [
    { value: false, label: 'This frame', icon: 'image', hint: 'Only the open frame' },
    {
      value: true,
      label: 'All frames',
      icon: 'burst_mode',
      hint: 'Every frame of the sequence, saved as it goes',
    },
  ];

  readonly labelActions: Choice<LabelAction>[] = [
    { value: 'invert', label: 'Invert', icon: 'invert_colors', hint: '' },
    { value: 'cut', label: 'Cut from others', icon: 'deselect', hint: '' },
  ];
  /** The action picked for the active label. */
  readonly labelAction = signal<LabelAction>('invert');
  readonly selectedLabelAction = computed(
    () => this.labelActions.find((a) => a.value === this.labelAction())!,
  );

  readonly invertModes: Choice<InvertMode>[] = [
    {
      value: 'unlabelled',
      label: 'Free space',
      icon: 'crop_free',
      hint: 'The label takes the pixels no label covers and gives up its own; other labels are untouched',
    },
    {
      value: 'whole',
      label: 'Everything else',
      icon: 'invert_colors',
      hint: 'The label becomes its exact complement, taking pixels from the other labels too',
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

  /** Each setting's dial: areas as a disc, lengths as a radius or a width,
   *  on a scale that is logarithmic above the knee so small values are easy
   *  to pick. */
  private readonly dials: Record<CleanParam, ParamDial> = {
    holeArea: {
      value: this.ops.holeArea,
      label: 'Holes up to',
      aria: 'Largest hole to fill, in pixels',
      mode: 'area',
      min: 0,
      max: 5000,
      exactMax: 10_000_000,
      knee: 20,
      step: 10,
      unit: 'px²',
      zeroLabel: 'any',
      aside: '0 = any size',
    },
    islandArea: {
      value: this.ops.islandArea,
      label: 'Islands up to',
      aria: 'Largest island to remove, in pixels',
      mode: 'area',
      min: 0,
      max: 5000,
      exactMax: 10_000_000,
      knee: 20,
      step: 10,
      unit: 'px²',
      zeroLabel: null,
      aside: null,
    },
    radius: {
      value: this.ops.radius,
      label: 'Radius',
      aria: 'Radius, in pixels',
      mode: 'radius',
      min: 1,
      max: 50,
      exactMax: 50,
      knee: 2,
      step: 1,
      unit: 'px',
      zeroLabel: null,
      aside: null,
    },
    smoothing: {
      value: this.ops.smoothing,
      label: 'Strength',
      aria: 'Smoothing strength, in pixels',
      mode: 'radius',
      min: 0.5,
      max: 20,
      exactMax: 20,
      knee: 1,
      step: 0.5,
      unit: 'px',
      zeroLabel: null,
      aside: null,
    },
    gapWidth: {
      value: this.ops.gapWidth,
      label: 'Gap up to',
      aria: 'Widest gap to fill, in pixels',
      mode: 'diameter',
      min: 1,
      max: 30,
      exactMax: 30,
      knee: 2,
      step: 1,
      unit: 'px',
      zeroLabel: null,
      aside: 'width',
    },
  };

  readonly frameCount = computed(() => this.sequence.frames().length);
  readonly selectedOp = computed(
    () => this.cleanOps.find((o) => o.value === this.ops.cleanOp()) ?? this.cleanOps[0],
  );

  /** The dial for the picked operation's setting; none for "Keep largest". */
  readonly paramDial = computed(() => {
    const param = this.selectedOp().param;
    return param ? this.dials[param] : null;
  });

  /** The dial takes the label's colour when it acts on the active label. */
  get dialColor(): string | null {
    return this.ops.target() === 'active' ? (this.activeLabel()?.color ?? null) : null;
  }

  /** A typed value, kept in the setting's range. */
  clampParam(dial: ParamDial, value: number | null): number {
    if (value === null || !Number.isFinite(value)) return dial.min;
    return Math.max(dial.min, Math.min(dial.exactMax, value));
  }

  /** What Invert does with the picked option, in words. */
  get invertHint(): string {
    return this.ops.invertMode() === 'whole'
      ? 'The label becomes its exact opposite, taking pixels from the other labels too.'
      : 'The label takes the pixels no label covers and gives up its own; other labels stay.';
  }

  applyLabelAction(): void {
    void (this.labelAction() === 'invert' ? this.ops.invert() : this.ops.subtractActive());
  }

  get busy(): boolean {
    return this.ops.progress() !== null;
  }

  /** What the clean-up applies to, in words. */
  get targetSummary(): string {
    switch (this.ops.target()) {
      case 'active':
        return this.activeLabel()?.label ?? 'no active label';
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
