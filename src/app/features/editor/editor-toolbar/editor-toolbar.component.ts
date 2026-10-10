import { IS_ANDROID } from '../../../core/platform';
import { Component, inject } from '@angular/core';
import { ToolbarModule } from 'primeng/toolbar';
import { ButtonModule } from 'primeng/button';
import { SelectButtonModule } from 'primeng/selectbutton';
import {
  CONVERT_TOOLS,
  RASTER_TOOLS,
  Tool,
  VECTOR_TOOLS,
} from '../../../core/tools';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EditorService } from '../services/editor.service';
import { ConvertService } from '../drawable-canvas/service/convert.service';
import { VectorEditorService } from '../drawable-canvas/service/vector-editor.service';
import { PredictionService } from '../drawable-canvas/service/prediction.service';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { BlockUIModule } from 'primeng/blockui';
import { PanelModule } from 'primeng/panel';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { TooltipModule } from 'primeng/tooltip';
import { SplitButtonModule } from 'primeng/splitbutton';
import { MenuItem } from 'primeng/api';

type PredictOutput = 'pixels' | 'paths' | 'centerlines';

const OUTPUT_KEY = 'dida.predict.output';

const OUTPUTS: { id: PredictOutput; label: string; icon: string }[] = [
  { id: 'pixels', label: 'Painted pixels', icon: 'pi pi-bolt' },
  { id: 'paths', label: 'Editable paths', icon: 'pi pi-pencil' },
  { id: 'centerlines', label: 'Centerlines', icon: 'pi pi-share-alt' },
];

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
        ToggleButtonModule,
        TooltipModule,
        SplitButtonModule,
    ],
    templateUrl: './editor-toolbar.component.html',
    styleUrl: './editor-toolbar.component.scss'
})
export class EditorToolbarComponent {
  /** No trained head on the tablet build. */
  readonly isAndroid = IS_ANDROID;
  editorService = inject(EditorService);
  vectorEditor = inject(VectorEditorService);
  prediction = inject(PredictionService);
  private convertService = inject(ConvertService);

  rasterTools = RASTER_TOOLS;
  vectorTools = VECTOR_TOOLS;
  convertTools = CONVERT_TOOLS;

  isSelected(tool: Tool): boolean {
    return this.editorService.selectedTool === tool;
  }

  toolTooltip(tool: Tool): string {
    const head = tool.shortcut ? `${tool.name} · ${tool.shortcut}` : tool.name;
    return tool.description ? `${head} — ${tool.description}` : head;
  }

  // The brush-size slider is logarithmic.
  private readonly brushMin = 1;
  private readonly brushMax = 1024;
  private readonly brushSteps = 1000;

  rasterize(): void {
    this.convertService.rasterize();
  }

  /** How the predicted mask is read back: pixels, outlines or centrelines.
   *  Persisted. */
  outputMode: PredictOutput =
    (localStorage.getItem(OUTPUT_KEY) as PredictOutput | null) ?? 'pixels';

  /** Use what is already drawn as conditioning. */
  useScribbles = true;

  /** The split button's dropdown; picking an output also runs it. Built once:
   *  a fresh array on every change detection rebuilds the menu under the
   *  cursor and swallows the click. */
  readonly outputMenu: MenuItem[] = OUTPUTS.map((o) => ({
    label: o.label,
    icon: o.icon,
    command: () => this.runAs(o.id),
  }));

  private runAs(mode: PredictOutput): void {
    this.outputMode = mode;
    localStorage.setItem(OUTPUT_KEY, mode);
    this.predict();
  }

  get outputLabel(): string {
    return OUTPUTS.find((o) => o.id === this.outputMode)?.label ?? 'Predict';
  }

  get predictLabel(): string {
    return this.prediction.stage() ?? this.outputLabel;
  }

  predict(): void {
    switch (this.outputMode) {
      case 'paths':
        void this.prediction.predictCurrentFrameAsVectors(this.useScribbles);
        break;
      case 'centerlines':
        void this.prediction.predictCurrentFrameAsSkeletons(this.useScribbles);
        break;
      default:
        void this.prediction.predictCurrentFrame(this.useScribbles);
    }
  }

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
