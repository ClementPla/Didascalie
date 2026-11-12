import { Component, inject, computed, ChangeDetectionStrategy } from '@angular/core';
import { PanelModule } from 'primeng/panel';
import { AccordionModule } from 'primeng/accordion';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { EditorService, PenButtonAction } from '../services/editor.service';
import { FormsModule } from '@angular/forms';
import { SliderModule } from 'primeng/slider';
import { ProjectService } from '../../../services/project/project.service';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SelectModule } from 'primeng/select';
import {
  PostProcessOption,
  REFINABLE_POST_PROCESS,
} from '../../../core/tools';
import { FeatureFlagsService } from '../../../experimental/feature-flags.service';
import { ExperimentalPostProcess } from '../../../experimental/descriptor';
import { findExperimentalPostProcess } from '../../../experimental/registry';

import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';

import { CommonModule } from '@angular/common';
import { ImageAdjustmentsComponent } from "./image-processing/image-adjustments/image-adjustments.component";
import { ChannelsPanelComponent } from "./channels-panel/channels-panel.component";
import { MaskOpsPanelComponent } from './mask-ops-panel/mask-ops-panel.component';
import { SequenceService } from "../../../services/sequence.service";
import { ChannelsService } from "../services/channels.service";

@Component({
    selector: 'app-tool-setting',
    imports: [
    CommonModule,
    PanelModule,
    SliderModule,
    ToggleSwitchModule,
    SelectButtonModule,
    SelectModule,
    InputTextModule,
    TooltipModule,
    FormsModule,
    AccordionModule,
    ImageAdjustmentsComponent,
    ChannelsPanelComponent,
    MaskOpsPanelComponent,
],
    templateUrl: './tool-setting.component.html',
    styleUrl: './tool-setting.component.scss',
    standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolSettingComponent {
  editorService = inject(EditorService);
  sequenceService = inject(SequenceService);
  private channels = inject(ChannelsService);

  /** What Otsu and flood fill can read on a multi-channel frame deeper than 8
   *  bits; empty otherwise (the picker is hidden). */
  readonly operatorSources = computed(() => {
    const info = this.sequenceService.currentPixelInfo();
    if (!info || info.channels < 2) return [];
    const names = this.channels.settings()?.channels ?? [];
    return [
      { label: 'Brightest visible channel', value: null as number | null },
      ...Array.from({ length: info.channels }, (_, c) => ({
        label: names[c]?.name || `Channel ${c + 1}`,
        value: c as number | null,
      })),
    ];
  });
  projectService = inject(ProjectService);
  flags = inject(FeatureFlagsService);

  ppOption = PostProcessOption;

  /** Pixel-level projects: the Boolean section applies. */
  get isSegmentationProject(): boolean {
    return (
      this.projectService.isSegmentation() ||
      this.projectService.isInstanceSegmentation()
    );
  }

  readonly penButtonActions: { label: string; value: PenButtonAction }[] = [
    { label: 'Off', value: 'none' },
    { label: 'Eraser', value: 'eraser' },
    { label: 'Pan', value: 'pan' },
    { label: 'Labels', value: 'picker' },
  ];

  /** The selected mode has the invert / smooth / connectivity options. */
  isOtsu(): boolean {
    return this.editorService.postProcessOption === PostProcessOption.OTSU;
  }

  isRefinable(): boolean {
    return REFINABLE_POST_PROCESS.includes(this.editorService.postProcessOption);
  }

  /** The registry entry of the selected mode, when it is experimental. */
  get experimentalPostProcess(): ExperimentalPostProcess | null {
    return findExperimentalPostProcess(this.editorService.postProcessOption);
  }
}
