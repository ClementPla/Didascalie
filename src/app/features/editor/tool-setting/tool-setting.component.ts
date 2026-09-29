import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { PanelModule } from 'primeng/panel';
import { AccordionModule } from 'primeng/accordion';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { EditorService } from '../services/editor.service';
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

  /** Whether the selected mode goes through the shared invert / smooth /
   *  connectivity refinement, which Otsu and flood fill both do. */
  isRefinable(): boolean {
    return REFINABLE_POST_PROCESS.includes(this.editorService.postProcessOption);
  }

  /** The registry entry for the selected post-process mode when it is an
   *  experimental one (rendered by the template's @default branch). */
  get experimentalPostProcess(): ExperimentalPostProcess | null {
    return findExperimentalPostProcess(this.editorService.postProcessOption);
  }
}
