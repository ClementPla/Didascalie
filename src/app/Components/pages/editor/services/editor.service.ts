import { Subject } from 'rxjs';
import { Injectable } from '@angular/core';
import { Tool, Tools, PostProcessOption } from '../../../../Core/tools';

@Injectable({
  providedIn: 'root',
})
export class EditorService {
  public _lastTool: Tool;
  public penPostProcess = false;
  public eraserPostProcess = false;
  public autoPostProcessOpening = false;
  public canvasClear: Subject<number> = new Subject<number>();
  public canvasRedraw: Subject<boolean> = new Subject<boolean>();
  public canvasSumRefresh: Subject<boolean> = new Subject<boolean>();
  public edgesOnly = false;
  public enforceConnectivity = false;
  public eraseAll = false;
  public labelOpacity = 1;
  public lineWidth = 10;
  /** Scale the brush radius by pen/touch pressure while drawing. */
  public pressureSensitivity = false;
  /** Live pointer pressure in [0, 1]. Updated per pointer event by the canvas
   *  input directive, read by the drawing tools and cursor. */
  public strokePressure = 1;
  /** Whether the active pointer reports real pressure (pen/touch). Mouse does
   *  not, so pressure scaling is skipped for it. */
  public strokeIsPressure = false;
  /** Brush radius multiplier at full pressure. Higher = more amplification;
   *  at 1.0 full pressure equals the base size. User-adjustable. */
  public pressureGain = 2.5;

  /** Lowest radius multiplier, at zero pressure. */
  private static readonly PRESSURE_MIN_SCALE = 0.15;

  /** Current brush-radius multiplier from pressure: `MIN..pressureGain` across
   *  the pressure range. Returns 1 (no scaling) when disabled or on mouse. */
  public brushPressureScale(): number {
    if (!this.pressureSensitivity || !this.strokeIsPressure) return 1;
    const min = EditorService.PRESSURE_MIN_SCALE;
    return min + (this.pressureGain - min) * this.strokePressure;
  }
  public morphoSize = 3;
  public redo: Subject<boolean> = new Subject<boolean>();
  private _selectedTool: Tool = Tools.PEN;
  /** Emits the new tool whenever the active tool changes (any source). */
  public readonly toolChanged$ = new Subject<Tool>();
  public swapMarkers = false;
  public undo: Subject<boolean> = new Subject<boolean>();
  public useInverse = false;
  public useProcessing = false;

  public showBoundingBox = false;
  public labelledCombinedBoundingBox = false;
  public bbxOpacity = 0.4;
  public eraseOnClick = false;

  public samThreshold = 0.5;

  public postProcessOption: PostProcessOption = PostProcessOption.OTSU;

  public incrementAfterStroke = false;

  public floodFillTolerance = 3.0;

  // On by default: the compositor self-tests at startup and reports itself
  // unavailable (falling back to CPU) if WebGPU is missing or produces wrong
  // output, so enabling this can't break rendering.
  public webGPURendering = true;
  public resetZoomAfterNavigation = true;
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

  /** Select tool: pick / move / duplicate whole paths (object-level). */
  public isSelectTool(): boolean {
    return this.selectedTool === Tools.SELECT;
  }

  /** Convert tool: click a connected pixel region to trace its outer contour. */
  public isVectorizeTool(): boolean {
    return this.selectedTool === Tools.VECTORIZE;
  }

  /** Convert tool: click a connected pixel region to trace its centerline. */
  public isSkeletonizeTool(): boolean {
    return this.selectedTool === Tools.SKELETONIZE;
  }

  /** True for the shape-editing vector tools (Select/Path/Node) — routes pointer
   *  input to the SVG layer. Excludes Vectorize, which acts on the raster masks. */
  public isVectorTool(): boolean {
    return this.isPathTool() || this.isNodeTool() || this.isSelectTool();
  }

  public isToolWithBrushSize(): boolean {
    return (
      this.selectedTool === Tools.PEN ||
      this.selectedTool === Tools.ERASER ||
      this.selectedTool === Tools.LINE
    );
  }

  public requestCanvasClear(index = -1) {
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
