import { Component } from '@angular/core';
import { PanelModule } from 'primeng/panel';

import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { EditorService } from '../../../../Services/UI/editor.service';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { FieldsetModule } from 'primeng/fieldset';
import { SliderModule } from 'primeng/slider';
import { ProjectService } from '../../../../Services/Project/project.service';
import { ImageProcessingService } from '../drawable-canvas/service/image-processing.service';
import { SelectButtonModule } from 'primeng/selectbutton';
import { PostProcessOption } from '../../../../Core/tools';
import { postProcessingOptions } from '../../../../Core/tools';
import { GenericsModule } from '../../../../generics/generics.module';
import { MessageModule } from 'primeng/message';

import { CommonModule } from '@angular/common';

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
        MessageModule,
    ],
    templateUrl: './tool-setting.component.html',
    styleUrl: './tool-setting.component.scss'
})
export class ToolSettingComponent {
  postProcessingOptions = postProcessingOptions;
  ppOption = PostProcessOption;
  constructor(
    public editorService: EditorService,
    public projectService: ProjectService,
    public imageProcess: ImageProcessingService
  ) {}
}
