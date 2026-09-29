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

/** What a prediction leaves behind. */
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
  editorService = inject(EditorService);
  vectorEditor = inject(VectorEditorService);
  prediction = inject(PredictionService);
  private convertService = inject(ConvertService);

  rasterTools = RASTER_TOOLS;
  vectorTools = VECTOR_TOOLS;
  convertTools = CONVERT_TOOLS;

  /** Drives the name shown beside a tool's icon: only the current tool's. */
  isSelected(tool: Tool): boolean {
    return this.editorService.selectedTool === tool;
  }

  /** Name, shortcut and what the tool does — the buttons are icon-only
   *  unless selected, so this is where they explain themselves. */
  toolTooltip(tool: Tool): string {
    const head = tool.shortcut ? `${tool.name} · ${tool.shortcut}` : tool.name;
    return tool.description ? `${head} — ${tool.description}` : head;
  }

  // Brush-size slider bounds. The slider is logarithmic so small, commonly-used
  // sizes get most of the track; the number input still edits lineWidth directly.
  private readonly brushMin = 1;
  private readonly brushMax = 1024;
  private readonly brushSteps = 1000;

  /** Burn the selected shape (or the active label's shapes) into the masks. */
  rasterize(): void {
    this.convertService.rasterize();
  }

  /**
   * What a prediction produces. Persisted so the toolbar reopens as left.
   *
   * The model predicts a raster mask in every case; this only decides how that
   * mask is read back — pixels, region outlines, or centerlines.
   */
  outputMode: PredictOutput =
    (localStorage.getItem(OUTPUT_KEY) as PredictOutput | null) ?? 'pixels';

  /** Feed what the user has already drawn in as conditioning. */
  useScribbles = true;

  /**
   * Output choices for the split button's dropdown; picking one also runs it.
   *
   * Built once and never reassigned. `p-splitButton` is `OnPush` and hands this
   * array straight to a `TieredMenu`, so a getter returning a fresh array on
   * every change-detection pass rebuilt the overlay continuously and the item
   * under the cursor was destroyed before its click could land — the menu
   * looked live and selected nothing.
   */
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

  /** Shows the live phase while a prediction runs, the target output otherwise. */
  get predictLabel(): string {
    return this.prediction.stage() ?? this.outputLabel;
  }

  /** Run the trained head on this frame, in the selected output mode. */
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
