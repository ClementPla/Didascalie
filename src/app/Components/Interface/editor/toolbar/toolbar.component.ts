import { AfterViewInit, ChangeDetectorRef, Component } from '@angular/core';
import { ToolbarModule } from 'primeng/toolbar';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import { Tools } from '../../../../Core/canvases/tools';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EditorService } from '../../../../Services/UI/editor.service';
import { SliderModule } from 'primeng/slider';
import { InputSwitchModule } from 'primeng/inputswitch';
import { LabelledSwitchComponent } from '../../../Core/labelled-switch/labelled-switch.component';
import { BlockUIModule } from 'primeng/blockui';
import { PanelModule } from 'primeng/panel';
import { BlockableP } from '../../../Core/Blockable/p/p.component';
import { BlockableDiv } from "../../../Core/Blockable/div/div.component";

@Component({
  selector: 'app-toolbar',
  standalone: true,
  imports: [
    ToolbarModule,
    ButtonModule,
    PanelModule,
    SelectButtonModule,
    BlockUIModule,
    CommonModule,
    FormsModule,
    SliderModule,
    InputSwitchModule,
    BlockableP,
    LabelledSwitchComponent,
    BlockableDiv
],
  templateUrl: './toolbar.component.html',
  styleUrl: './toolbar.component.scss',
})
export class ToolbarComponent implements AfterViewInit {
  tools = Tools.ALL_TOOLS;

  constructor(
    public editorService: EditorService,
    private cdr: ChangeDetectorRef
  ) {}

  ngAfterViewInit(): void {
    this.cdr.detectChanges();
  }
}
