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
import { PostProcessService } from '../drawable-canvas/service/post-process.service';
import { SelectButtonModule } from 'primeng/selectbutton';
import { PostProcessOption } from '../../../../Core/tools';
import { postProcessingOptions } from '../../../../Core/tools';
import { GenericsModule } from '../../../../generics/generics.module';
import { MessageModule } from 'primeng/message';

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
  postProcessingOptions = postProcessingOptions;
  ppOption = PostProcessOption;
  constructor(
    public editorService: EditorService,
    public projectService: ProjectService,
    public imageProcess: ImageAdjustmentService,
    private postProcess: PostProcessService
  ) {}

  /** Toggle the superpixel boundary overlay on/off. */
  onToggleSuperpixels() {
    void this.postProcess.updateSuperpixelOverlay();
  }

  /** The superpixel count changed: drop the cached map and, if the overlay is
   *  visible, recompute it with the new granularity. */
  onSuperpixelCountChange() {
    this.postProcess.invalidateSuperpixels();
    if (this.editorService.showSuperpixels) {
      void this.postProcess.updateSuperpixelOverlay();
    }
  }
}
