import { Subject } from 'rxjs';
import { Injectable, signal } from '@angular/core';
import { Tool, Tools, PostProcessOption } from '../../../core/tools';

/**
 * Editor-wide tool and rendering settings.
 *
 * # Why signals sit behind accessors here
 *
 * Every field below is read directly from templates and written from both
 * templates (`[(ngModel)]`, `[(checked)]`) and TypeScript. Plain fields cannot
 * support `OnPush`: reading one does not mark the view dirty, so a component
 * rendering from this service would simply stop repainting.
 *
 * Exposing `WritableSignal`s directly would be the more idiomatic API, but it
 * would also rewrite 224 call sites across eight components — and, because
 * `[(ngModel)]` desugars to an assignment, it cannot two-way bind to a signal
 * at all, so every one of those bindings would have to be split by hand.
 *
 * A signal behind a getter/setter gets the reactivity without any of that. The
 * getter runs *during* template evaluation, so the signal read is tracked and
 * the view updates; the setter keeps `[(ngModel)]` and every existing
 * assignment working unchanged. The trade is boilerplate in this file against
 * risk spread across the app, which is the right way round for a change no
 * compiler can verify.
 *
 * The same applies to `selectedTool`: the predicate methods below (`isEraser`,
 * `isDrawingTool`, …) read it, and templates call those methods. A signal read
 * inside a method still counts as a read during change detection, so those
 * calls become reactive too, with no change at their call sites.
 */
@Injectable({
  providedIn: 'root',
})
export class EditorService {
  public _lastTool: Tool;

  public canvasClear: Subject<number> = new Subject<number>();
  public canvasRedraw: Subject<boolean> = new Subject<boolean>();
  public canvasSumRefresh: Subject<boolean> = new Subject<boolean>();
  public redo: Subject<boolean> = new Subject<boolean>();
  public undo: Subject<boolean> = new Subject<boolean>();

  /** Emits the new tool whenever the active tool changes (any source). */
  public readonly toolChanged$ = new Subject<Tool>();

  // ==========================================
  // Post-processing
  // ==========================================

  private readonly _penPostProcess = signal(false);
  get penPostProcess(): boolean { return this._penPostProcess(); }
  set penPostProcess(v: boolean) { this._penPostProcess.set(v); }

  private readonly _eraserPostProcess = signal(false);
  get eraserPostProcess(): boolean { return this._eraserPostProcess(); }
  set eraserPostProcess(v: boolean) { this._eraserPostProcess.set(v); }

  private readonly _autoPostProcessOpening = signal(false);
  get autoPostProcessOpening(): boolean { return this._autoPostProcessOpening(); }
  set autoPostProcessOpening(v: boolean) { this._autoPostProcessOpening.set(v); }

  private readonly _postProcessOption = signal<PostProcessOption>(PostProcessOption.OTSU);
  get postProcessOption(): PostProcessOption { return this._postProcessOption(); }
  set postProcessOption(v: PostProcessOption) { this._postProcessOption.set(v); }

  private readonly _morphoSize = signal(3);
  get morphoSize(): number { return this._morphoSize(); }
  set morphoSize(v: number) { this._morphoSize.set(v); }

  private readonly _edgesOnly = signal(false);
  get edgesOnly(): boolean { return this._edgesOnly(); }
  set edgesOnly(v: boolean) { this._edgesOnly.set(v); }

  private readonly _enforceConnectivity = signal(false);
  get enforceConnectivity(): boolean { return this._enforceConnectivity(); }
  set enforceConnectivity(v: boolean) { this._enforceConnectivity.set(v); }

  // ==========================================
  // Drawing
  // ==========================================

  private readonly _eraseAll = signal(false);
  get eraseAll(): boolean { return this._eraseAll(); }
  set eraseAll(v: boolean) { this._eraseAll.set(v); }

  private readonly _eraseOnClick = signal(false);
  get eraseOnClick(): boolean { return this._eraseOnClick(); }
  set eraseOnClick(v: boolean) { this._eraseOnClick.set(v); }

  private readonly _labelOpacity = signal(1);
  get labelOpacity(): number { return this._labelOpacity(); }
  set labelOpacity(v: number) { this._labelOpacity.set(v); }

  private readonly _lineWidth = signal(10);
  get lineWidth(): number { return this._lineWidth(); }
  set lineWidth(v: number) { this._lineWidth.set(v); }

  private readonly _swapMarkers = signal(false);
  get swapMarkers(): boolean { return this._swapMarkers(); }
  set swapMarkers(v: boolean) { this._swapMarkers.set(v); }

  private readonly _incrementAfterStroke = signal(false);
  get incrementAfterStroke(): boolean { return this._incrementAfterStroke(); }
  set incrementAfterStroke(v: boolean) { this._incrementAfterStroke.set(v); }

  private readonly _floodFillTolerance = signal(3.0);
  get floodFillTolerance(): number { return this._floodFillTolerance(); }
  set floodFillTolerance(v: number) { this._floodFillTolerance.set(v); }

  // ==========================================
  // Pressure
  // ==========================================

  /** Scale the brush radius by pen/touch pressure while drawing. */
  private readonly _pressureSensitivity = signal(false);
  get pressureSensitivity(): boolean { return this._pressureSensitivity(); }
  set pressureSensitivity(v: boolean) { this._pressureSensitivity.set(v); }

  /** Live pointer pressure in [0, 1]. Updated per pointer event by the canvas
   *  input directive, read by the drawing tools and cursor. */
  private readonly _strokePressure = signal(1);
  get strokePressure(): number { return this._strokePressure(); }
  set strokePressure(v: number) { this._strokePressure.set(v); }

  /** Whether the active pointer reports real pressure (pen/touch). Mouse does
   *  not, so pressure scaling is skipped for it. */
  private readonly _strokeIsPressure = signal(false);
  get strokeIsPressure(): boolean { return this._strokeIsPressure(); }
  set strokeIsPressure(v: boolean) { this._strokeIsPressure.set(v); }

  /** Brush radius multiplier at full pressure. Higher = more amplification;
   *  at 1.0 full pressure equals the base size. User-adjustable. */
  private readonly _pressureGain = signal(2.5);
  get pressureGain(): number { return this._pressureGain(); }
  set pressureGain(v: number) { this._pressureGain.set(v); }

  /** Lowest radius multiplier, at zero pressure. */
  private static readonly PRESSURE_MIN_SCALE = 0.15;

  /** Current brush-radius multiplier from pressure: `MIN..pressureGain` across
   *  the pressure range. Returns 1 (no scaling) when disabled or on mouse. */
  public brushPressureScale(): number {
    if (!this.pressureSensitivity || !this.strokeIsPressure) return 1;
    const min = EditorService.PRESSURE_MIN_SCALE;
    return min + (this.pressureGain - min) * this.strokePressure;
  }

  // ==========================================
  // Bounding boxes
  // ==========================================

  private readonly _showBoundingBox = signal(false);
  get showBoundingBox(): boolean { return this._showBoundingBox(); }
  set showBoundingBox(v: boolean) { this._showBoundingBox.set(v); }

  private readonly _labelledCombinedBoundingBox = signal(false);
  get labelledCombinedBoundingBox(): boolean { return this._labelledCombinedBoundingBox(); }
  set labelledCombinedBoundingBox(v: boolean) { this._labelledCombinedBoundingBox.set(v); }

  private readonly _bbxOpacity = signal(0.4);
  get bbxOpacity(): number { return this._bbxOpacity(); }
  set bbxOpacity(v: number) { this._bbxOpacity.set(v); }

  // ==========================================
  // Image processing / model
  // ==========================================

  private readonly _useInverse = signal(false);
  get useInverse(): boolean { return this._useInverse(); }
  set useInverse(v: boolean) { this._useInverse.set(v); }

  private readonly _useProcessing = signal(false);
  get useProcessing(): boolean { return this._useProcessing(); }
  set useProcessing(v: boolean) { this._useProcessing.set(v); }

  // ==========================================
  // Rendering / navigation
  // ==========================================

  // On by default: the compositor self-tests at startup and reports itself
  // unavailable (falling back to CPU) if WebGPU is missing or produces wrong
  // output, so enabling this can't break rendering.
  private readonly _webGPURendering = signal(true);
  get webGPURendering(): boolean { return this._webGPURendering(); }
  set webGPURendering(v: boolean) { this._webGPURendering.set(v); }

  private readonly _resetZoomAfterNavigation = signal(true);
  get resetZoomAfterNavigation(): boolean { return this._resetZoomAfterNavigation(); }
  set resetZoomAfterNavigation(v: boolean) { this._resetZoomAfterNavigation.set(v); }

  // ==========================================
  // Active tool
  // ==========================================

  private readonly _selectedTool = signal<Tool>(Tools.PEN);

  /** The active tool. Writing it (toolbar ngModel, selectTool, pan toggles)
   *  emits toolChanged$ so listeners can react (e.g. finalize a vector draft). */
  get selectedTool(): Tool {
    return this._selectedTool();
  }
  set selectedTool(tool: Tool) {
    const previous = this._selectedTool();
    if (previous === tool) return;
    // Pan is transient navigation (hold Space, or the Navigate toggle), so it
    // never becomes the tool Alt swaps back to — otherwise a stray Space press
    // would hijack the two-tool toggle.
    if (previous !== Tools.PAN && tool !== Tools.PAN) {
      this._previousTool.set(previous);
    }
    this._selectedTool.set(tool);
    this.toolChanged$.next(tool);
  }

  /** The tool used before the current one, ignoring pan. */
  private readonly _previousTool = signal<Tool>(Tools.ERASER);
  get previousTool(): Tool {
    return this._previousTool();
  }

  /** Flip between the current tool and the one before it — what tapping Alt
   *  without aiming at anything in the quick-access wheel does. */
  public swapToPreviousTool(): void {
    this.selectedTool = this._previousTool();
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
