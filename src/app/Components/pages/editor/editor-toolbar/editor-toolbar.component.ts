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

  // Brush-size slider bounds. The slider is logarithmic so small, commonly-used
  // sizes get most of the track; the number input still edits lineWidth directly.
  private readonly brushMin = 1;
  private readonly brushMax = 1024;
  private readonly brushSteps = 1000;

  constructor(public editorService: EditorService) {}

  /** Slider position [0, brushSteps] mapped logarithmically from lineWidth. */
  get brushSizeSlider(): number {
    const v = Math.min(this.brushMax, Math.max(this.brushMin, this.editorService.lineWidth));
    return Math.round(
      (this.brushSteps * Math.log(v / this.brushMin)) /
        Math.log(this.brushMax / this.brushMin)
    );
  }

  set brushSizeSlider(pos: number) {
    const v =
      this.brushMin *
      Math.pow(this.brushMax / this.brushMin, pos / this.brushSteps);
    this.editorService.lineWidth = Math.max(
      this.brushMin,
      Math.min(this.brushMax, Math.round(v))
    );
  }
}
