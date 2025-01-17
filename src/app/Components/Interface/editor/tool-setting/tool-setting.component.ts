import { Component } from '@angular/core';
import { PanelModule } from 'primeng/panel';
import { NgIf, NgSwitch, CommonModule } from '@angular/common';
import { InputSwitchModule } from 'primeng/inputswitch';
import { EditorService } from '../../../../Services/UI/editor.service';
import { FormsModule } from '@angular/forms';
import { CardModule } from 'primeng/card';
import { FieldsetModule } from 'primeng/fieldset';
import { SliderModule } from 'primeng/slider';
import { ProjectService } from '../../../../Services/Project/project.service';
import { ImageProcessingService } from '../../../Core/drawable-canvas/service/image-processing.service';
import { SelectButtonModule } from 'primeng/selectbutton';
import { PostProcessOption } from '../../../../Core/tools';
import { postProcessingOptions } from '../../../../Core/tools';
import { GenericsModule } from '../../../../generics/generics.module';

@Component({
  selector: 'app-tool-setting',
  standalone: true,
  imports: [
    CommonModule,
    PanelModule,
    SliderModule,
    NgIf,
    InputSwitchModule,
    NgSwitch,
    SelectButtonModule,
    FormsModule,
    CardModule,
    GenericsModule,
    FieldsetModule,
  ],
  templateUrl: './tool-setting.component.html',
  styleUrl: './tool-setting.component.scss',
})
export class ToolSettingComponent {
  postProcessingOptions = postProcessingOptions;
  ppOption = PostProcessOption;
  constructor(
    public drawService: EditorService,
    public projectService: ProjectService,
    public imageProcess: ImageProcessingService
  ) {}
}
