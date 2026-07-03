import { Component } from '@angular/core';
import { PanelModule } from 'primeng/panel';
import { AccordionModule } from 'primeng/accordion';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { EditorService } from '../services/editor.service';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { FieldsetModule } from 'primeng/fieldset';
import { SliderModule } from 'primeng/slider';
import { ProjectService } from '../../../../Services/ProjectService/project.service';
import { ImageAdjustmentService } from '../drawable-canvas/service/image-adjustment/image-adjustment.service';
import { SelectButtonModule } from 'primeng/selectbutton';
import { PostProcessOption } from '../../../../Core/tools';
import { GenericsModule } from '../../../../generics/generics.module';
import { MessageModule } from 'primeng/message';
import { FeatureFlagsService } from '../../../../experimental/feature-flags.service';
import { ExperimentalPostProcess } from '../../../../experimental/descriptor';
import { findExperimentalPostProcess } from '../../../../experimental/registry';

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
    FormsModule,
    CardModule,
    GenericsModule,
    FieldsetModule,
    AccordionModule,
    MessageModule,
    ImageAdjustmentsComponent
],
    templateUrl: './tool-setting.component.html',
    styleUrl: './tool-setting.component.scss',
    standalone: true,
})
export class ToolSettingComponent {
  ppOption = PostProcessOption;
  constructor(
    public editorService: EditorService,
    public projectService: ProjectService,
    public imageProcess: ImageAdjustmentService,
    public flags: FeatureFlagsService
  ) {}

  /** The registry entry for the selected post-process mode when it is an
   *  experimental one (rendered by the template's @default branch). */
  get experimentalPostProcess(): ExperimentalPostProcess | null {
    return findExperimentalPostProcess(this.editorService.postProcessOption);
  }
}
