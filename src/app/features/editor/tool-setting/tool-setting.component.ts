import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { PanelModule } from 'primeng/panel';
import { AccordionModule } from 'primeng/accordion';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { EditorService, PenButtonAction } from '../services/editor.service';
import { FormsModule } from '@angular/forms';
import { SliderModule } from 'primeng/slider';
import { ProjectService } from '../../../services/project/project.service';
import { ImageAdjustmentService } from '../drawable-canvas/service/image-adjustment/image-adjustment.service';
import { SelectButtonModule } from 'primeng/selectbutton';
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

@Component({
    selector: 'app-tool-setting',
    imports: [
    CommonModule,
    PanelModule,
    SliderModule,
    ToggleSwitchModule,
    SelectButtonModule,
    InputTextModule,
    TooltipModule,
    FormsModule,
    AccordionModule,
    ImageAdjustmentsComponent
],
    templateUrl: './tool-setting.component.html',
    styleUrl: './tool-setting.component.scss',
    standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToolSettingComponent {
  editorService = inject(EditorService);
  projectService = inject(ProjectService);
  imageProcess = inject(ImageAdjustmentService);
  flags = inject(FeatureFlagsService);

  ppOption = PostProcessOption;

  readonly penButtonActions: { label: string; value: PenButtonAction }[] = [
    { label: 'Off', value: 'none' },
    { label: 'Eraser', value: 'eraser' },
    { label: 'Pan', value: 'pan' },
    { label: 'Labels', value: 'picker' },
  ];

  /** The selected mode has the invert / smooth / connectivity options. */
  isRefinable(): boolean {
    return REFINABLE_POST_PROCESS.includes(this.editorService.postProcessOption);
  }

  /** The registry entry of the selected mode, when it is experimental. */
  get experimentalPostProcess(): ExperimentalPostProcess | null {
    return findExperimentalPostProcess(this.editorService.postProcessOption);
  }
}
