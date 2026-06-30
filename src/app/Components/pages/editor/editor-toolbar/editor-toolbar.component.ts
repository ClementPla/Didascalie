import { AfterViewInit, ChangeDetectorRef, Component } from '@angular/core';
import { ToolbarModule } from 'primeng/toolbar';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ALL_TOOLS, VECTOR_TOOLS } from '../../../../Core/tools';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EditorService } from '../services/editor.service';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { BlockUIModule } from 'primeng/blockui';
import { PanelModule } from 'primeng/panel';
import { GenericsModule } from '../../../../generics/generics.module';
import { TooltipModule } from 'primeng/tooltip';

@Component({
    selector: 'app-editor-toolbar',
    imports: [
        ToolbarModule,
        ButtonModule,
        PanelModule,
        SelectButtonModule,
        BlockUIModule,
        CommonModule,
        FormsModule,
        SliderModule,
        ToggleSwitchModule,
        GenericsModule,
        TooltipModule,
    ],
    templateUrl: './editor-toolbar.component.html',
    styleUrl: './editor-toolbar.component.scss'
})
export class EditorToolbarComponent {
  tools = ALL_TOOLS;
  vectorTools = VECTOR_TOOLS;

  constructor(public editorService: EditorService) {}
}
