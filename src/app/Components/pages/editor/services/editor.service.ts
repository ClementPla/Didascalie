import { Subject } from 'rxjs';
import { Injectable } from '@angular/core';
import { Tool, Tools, PostProcessOption } from '../../../../Core/tools';

@Injectable({
  providedIn: 'root',
})
export class EditorService {
  public _lastTool: Tool;
  public penPostProcess: boolean = false;
  public eraserPostProcess: boolean = false;
  public autoPostProcessOpening: boolean = false;
  public canvasClear: Subject<number> = new Subject<number>();
  public canvasRedraw: Subject<boolean> = new Subject<boolean>();
  public canvasSumRefresh: Subject<boolean> = new Subject<boolean>();
  public edgesOnly: boolean = false;
  public enforceConnectivity: boolean = false;
  public eraseAll: boolean = false;
  public labelOpacity: number = 1;
  public lineWidth: number = 10;
  /** Scale the brush radius by pen/touch pressure while drawing. */
  public pressureSensitivity: boolean = true;
  /** Live pointer pressure in [0, 1]. Updated per pointer event by the canvas
   *  input directive, read by the drawing tools and cursor. */
  public strokePressure: number = 1;
  /** Whether the active pointer reports real pressure (pen/touch). Mouse does
   *  not, so pressure scaling is skipped for it. */
  public strokeIsPressure: boolean = false;
  /** Brush radius multiplier at full pressure. Higher = more amplification;
   *  at 1.0 full pressure equals the base size. User-adjustable. */
  public pressureGain: number = 2.5;

  /** Lowest radius multiplier, at zero pressure. */
  private static readonly PRESSURE_MIN_SCALE = 0.15;

  /** Current brush-radius multiplier from pressure: `MIN..pressureGain` across
   *  the pressure range. Returns 1 (no scaling) when disabled or on mouse. */
  public brushPressureScale(): number {
    if (!this.pressureSensitivity || !this.strokeIsPressure) return 1;
    const min = EditorService.PRESSURE_MIN_SCALE;
    return min + (this.pressureGain - min) * this.strokePressure;
  }
  public morphoSize: number = 3;
  public redo: Subject<boolean> = new Subject<boolean>();
  private _selectedTool: Tool = Tools.PEN;
  /** Emits the new tool whenever the active tool changes (any source). */
  public readonly toolChanged$ = new Subject<Tool>();
  public swapMarkers: boolean = false;
  public undo: Subject<boolean> = new Subject<boolean>();
  public useInverse: boolean = false;
  public useProcessing: boolean = false;

  public showBoundingBox: boolean = false;
  public labelledCombinedBoundingBox: boolean = false;
  public bbxOpacity: number = 0.4;
  public eraseOnClick: boolean = false;

  public samThreshold: number = 0.5;

  public postProcessOption: PostProcessOption = PostProcessOption.OTSU;

  public incrementAfterStroke: boolean = false;

  public floodFillTolerance: number = 3.0;

  /** Superpixel refinement settings. */
  public superpixelCount: number = 2000; // approximate number of superpixels
  public superpixelThreshold: number = 10.0; // CIEDE2000 similarity tolerance
  public superpixelMinOverlap: number = 0.15; // min stroke coverage of a superpixel
  public showSuperpixels: boolean = false; // overlay the superpixel boundaries

  public webGPURendering: boolean = false;
  public resetZoomAfterNavigation: boolean = true;
  constructor() {}

  /** The active tool. Writing it (toolbar ngModel, selectTool, pan toggles)
   *  emits toolChanged$ so listeners can react (e.g. finalize a vector draft). */
  get selectedTool(): Tool {
    return this._selectedTool;
  }
  set selectedTool(tool: Tool) {
    if (this._selectedTool === tool) return;
    this._selectedTool = tool;
    this.toolChanged$.next(tool);
  }

  public activatePanMode() {
    this._lastTool = this.selectedTool;
    this.selectedTool = Tools.PAN;
  }

  public affectsMultipleLabels(): boolean {
    return this.eraseAll || this.swapMarkers;
  }

  public canPan(): boolean {
    return this.selectedTool === Tools.PAN;
  }

  public isDrawingTool(): boolean {
    return (
      this.selectedTool === Tools.PEN ||
      this.selectedTool === Tools.LASSO ||
      this.selectedTool === Tools.LINE
    );
  }

  public isEraser(): boolean {
    return (
      this.selectedTool === Tools.ERASER ||
      this.selectedTool === Tools.LASSO_ERASER
    );
  }

  public isPathTool(): boolean {
    return this.selectedTool === Tools.PATH;
  }

  public isNodeTool(): boolean {
    return this.selectedTool === Tools.NODE;
  }

  /** True for any vector tool (Path/Node) — used to route input to the SVG layer. */
  public isVectorTool(): boolean {
    return this.isPathTool() || this.isNodeTool();
  }

  public isToolWithBrushSize(): boolean {
    return (
      this.selectedTool === Tools.PEN ||
      this.selectedTool === Tools.ERASER ||
      this.selectedTool === Tools.LINE
    );
  }

  public requestCanvasClear(index: number = -1) {
    this.canvasClear.next(index);
  }

  public requestCanvasRedraw() {
    this.canvasRedraw.next(true);
  }

  public requestRedo() {
    this.redo.next(true);
  }

  public requestUndo() {
    this.undo.next(true);
  }

  public restoreLastTool() {
    this.selectedTool = this._lastTool;
  }

  public selectTool(tool: Tool) {
    this.selectedTool = tool;
  }
}
