import { Subject } from 'rxjs';
import { Injectable, signal } from '@angular/core';
import { Tool, Tools, PostProcessOption } from '../../../core/tools';

/**
 * Editor-wide tool and rendering settings.
 *
 * Each field is a signal behind a getter/setter: templates read and write
 * them with `[(ngModel)]`, which cannot bind to a signal, and a plain field
 * would not update an `OnPush` view. The predicate methods (`isEraser`,
 * `isDrawingTool`, …) read the tool signal, so calling them from a template
 * is reactive too.
 */
/** What the pen's side button can be bound to. */
export type PenButtonAction = 'none' | 'eraser' | 'pan' | 'picker';

/** How a drawing stroke treats labels already under it. `swap`: only pixels
 *  a target label holds move to the active label. `swapDraw`: the same, and
 *  the rest of the stroke is drawn as usual. */
export type SwapMode = 'off' | 'swap' | 'swapDraw';

/** Which labels a swap may take pixels from. */
export type SwapTarget = 'all' | 'visible' | 'selected';

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

  public readonly toolChanged$ = new Subject<Tool>();

  // ── Post-processing ──────────────────────────────────────────────────────

  private readonly _penPostProcess = signal(false);
  get penPostProcess(): boolean { return this._penPostProcess(); }
  set penPostProcess(v: boolean) { this._penPostProcess.set(v); }

  private readonly _eraserPostProcess = signal(false);
  get eraserPostProcess(): boolean { return this._eraserPostProcess(); }
  set eraserPostProcess(v: boolean) { this._eraserPostProcess.set(v); }

  /** Outline smoothing of a refined stroke, 0..100: a share of the brush
   *  size, so one setting suits small and large structures alike. */
  private readonly _smoothing = signal(0);
  get smoothing(): number { return this._smoothing(); }
  set smoothing(v: number) { this._smoothing.set(v); }

  private readonly _fillHoles = signal(false);
  get fillHoles(): boolean { return this._fillHoles(); }
  set fillHoles(v: boolean) { this._fillHoles.set(v); }

  /** Blur applied to the image before Otsu thresholds it, in pixels. */
  private readonly _denoise = signal(0);
  get denoise(): number { return this._denoise(); }
  set denoise(v: number) { this._denoise.set(v); }

  private readonly _postProcessOption = signal<PostProcessOption>(PostProcessOption.OTSU);
  get postProcessOption(): PostProcessOption { return this._postProcessOption(); }
  set postProcessOption(v: PostProcessOption) { this._postProcessOption.set(v); }


  /** Outline mode: labels show as a fill and a contour band, each with its
   *  own visibility and opacity (below). Its defaults show the edges only. */
  private readonly _edgesOnly = signal(false);
  get edgesOnly(): boolean { return this._edgesOnly(); }
  set edgesOnly(v: boolean) { this._edgesOnly.set(v); }

  private readonly _outlineShowFill = signal(false);
  get outlineShowFill(): boolean { return this._outlineShowFill(); }
  set outlineShowFill(v: boolean) { this._outlineShowFill.set(v); }

  private readonly _outlineFillOpacity = signal(0.3);
  get outlineFillOpacity(): number { return this._outlineFillOpacity(); }
  set outlineFillOpacity(v: number) { this._outlineFillOpacity.set(v); }

  private readonly _outlineShowContour = signal(true);
  get outlineShowContour(): boolean { return this._outlineShowContour(); }
  set outlineShowContour(v: boolean) { this._outlineShowContour.set(v); }

  private readonly _outlineContourOpacity = signal(1);
  get outlineContourOpacity(): number { return this._outlineContourOpacity(); }
  set outlineContourOpacity(v: number) { this._outlineContourOpacity.set(v); }

  /** Contour band thickness, in screen pixels. */
  private readonly _outlineContourWidth = signal(2);
  get outlineContourWidth(): number { return this._outlineContourWidth(); }
  set outlineContourWidth(v: number) { this._outlineContourWidth.set(v); }

  /** Fill and contour opacities in outline mode, 0 where hidden; null when
   *  labels are drawn plainly. */
  public outlineAlphas(): { fillAlpha: number; contourAlpha: number } | null {
    if (!this.edgesOnly) return null;
    return {
      fillAlpha: this.outlineShowFill ? this.outlineFillOpacity : 0,
      contourAlpha: this.outlineShowContour ? this.outlineContourOpacity : 0,
    };
  }

  private readonly _enforceConnectivity = signal(false);
  get enforceConnectivity(): boolean { return this._enforceConnectivity(); }
  set enforceConnectivity(v: boolean) { this._enforceConnectivity.set(v); }

  // ── Drawing ──────────────────────────────────────────────────────────────

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

  /** The Boolean section of the settings panel is open. */
  private readonly _showMaskOps = signal(false);
  get showMaskOps(): boolean { return this._showMaskOps(); }
  set showMaskOps(v: boolean) { this._showMaskOps.set(v); }

  /** Smooth pen, eraser and lasso strokes (strengths below). */
  private readonly _smoothStrokes = signal(false);
  get smoothStrokes(): boolean { return this._smoothStrokes(); }
  set smoothStrokes(v: boolean) { this._smoothStrokes.set(v); }

  /** Pen and eraser stabilizer: the brush trails the pointer on a string this
   *  long, in screen pixels. */
  private readonly _brushStabilizer = signal(8);
  get brushStabilizer(): number { return this._smoothStrokes() ? this._brushStabilizer() : 0; }
  set brushStabilizer(v: number) { this._brushStabilizer.set(v); }

  /** Lasso outline smoothing radius, in screen pixels. */
  private readonly _lassoSmoothing = signal(6);
  get lassoSmoothing(): number { return this._smoothStrokes() ? this._lassoSmoothing() : 0; }
  set lassoSmoothing(v: number) { this._lassoSmoothing.set(v); }

  private readonly _swapMode = signal<SwapMode>('off');
  get swapMode(): SwapMode { return this._swapMode(); }
  set swapMode(v: SwapMode) {
    if (v !== 'off') this.lastSwapMode = v;
    this._swapMode.set(v);
  }
  /** The mode a plain on/off toggle turns back on. */
  private lastSwapMode: Exclude<SwapMode, 'off'> = 'swap';

  /** Swap is on, in either mode. Setting it on restores the last mode. */
  get swapMarkers(): boolean { return this._swapMode() !== 'off'; }
  set swapMarkers(v: boolean) { this.swapMode = v ? this.lastSwapMode : 'off'; }

  private readonly _swapTarget = signal<SwapTarget>('visible');
  get swapTarget(): SwapTarget { return this._swapTarget(); }
  set swapTarget(v: SwapTarget) { this._swapTarget.set(v); }

  /** Label ids a `selected` swap may take pixels from. */
  private readonly _swapTargetLabels = signal<number[]>([]);
  get swapTargetLabels(): number[] { return this._swapTargetLabels(); }
  set swapTargetLabels(v: number[]) { this._swapTargetLabels.set(v); }

  private readonly _incrementAfterStroke = signal(false);
  get incrementAfterStroke(): boolean { return this._incrementAfterStroke(); }
  set incrementAfterStroke(v: boolean) { this._incrementAfterStroke.set(v); }

  /** What Otsu and flood fill read on a frame deeper than 8 bits: null for the
   *  brightest visible channel, or one channel index. */
  private readonly _operatorChannel = signal<number | null>(null);
  get operatorChannel(): number | null { return this._operatorChannel(); }
  set operatorChannel(v: number | null) { this._operatorChannel.set(v); }

  private readonly _floodFillTolerance = signal(3.0);
  get floodFillTolerance(): number { return this._floodFillTolerance(); }
  set floodFillTolerance(v: number) { this._floodFillTolerance.set(v); }

  // ── Pressure ─────────────────────────────────────────────────────────────

  /** Scale the brush radius by pen pressure. */
  private readonly _pressureSensitivity = signal(true);
  get pressureSensitivity(): boolean { return this._pressureSensitivity(); }
  set pressureSensitivity(v: boolean) { this._pressureSensitivity.set(v); }

  /** Only the pen draws; a finger pans instead. */
  private readonly _penOnlyDrawing = signal(true);
  get penOnlyDrawing(): boolean { return this._penOnlyDrawing(); }
  set penOnlyDrawing(v: boolean) { this._penOnlyDrawing.set(v); }

  /** The "Touch & pen" section of the settings panel is open. */
  private readonly _touchSettingsOpen = signal(false);
  get touchSettingsOpen(): boolean { return this._touchSettingsOpen(); }
  set touchSettingsOpen(v: boolean) { this._touchSettingsOpen.set(v); }

  get penButtonEnabled(): boolean { return this._penButtonAction() !== 'none'; }

  /** What a stroke made with the pen's side button held does. */
  private readonly _penButtonAction = signal<PenButtonAction>('none');
  get penButtonAction(): PenButtonAction { return this._penButtonAction(); }
  set penButtonAction(v: PenButtonAction) { this._penButtonAction.set(v); }

  /** Live pointer pressure in [0, 1], set by the canvas input directive. */
  private readonly _strokePressure = signal(1);
  get strokePressure(): number { return this._strokePressure(); }
  set strokePressure(v: number) { this._strokePressure.set(v); }

  /** The active pointer reports real pressure. A mouse does not. */
  private readonly _strokeIsPressure = signal(false);
  get strokeIsPressure(): boolean { return this._strokeIsPressure(); }
  set strokeIsPressure(v: boolean) { this._strokeIsPressure.set(v); }

  /** Brush radius multiplier at full pressure. */
  private readonly _pressureGain = signal(2.5);
  get pressureGain(): number { return this._pressureGain(); }
  set pressureGain(v: number) { this._pressureGain.set(v); }

  /** Lowest radius multiplier, at zero pressure. */
  private static readonly PRESSURE_MIN_SCALE = 0.15;

  /** Brush-radius multiplier from pressure, `MIN..pressureGain`; 1 when
   *  disabled or on a mouse. */
  public brushPressureScale(): number {
    if (!this.pressureSensitivity || !this.strokeIsPressure) return 1;
    const min = EditorService.PRESSURE_MIN_SCALE;
    return min + (this.pressureGain - min) * this.strokePressure;
  }

  // ── Bounding boxes ───────────────────────────────────────────────────────

  private readonly _showBoundingBox = signal(false);
  get showBoundingBox(): boolean { return this._showBoundingBox(); }
  set showBoundingBox(v: boolean) { this._showBoundingBox.set(v); }

  private readonly _labelledCombinedBoundingBox = signal(false);
  get labelledCombinedBoundingBox(): boolean { return this._labelledCombinedBoundingBox(); }
  set labelledCombinedBoundingBox(v: boolean) { this._labelledCombinedBoundingBox.set(v); }

  private readonly _bbxOpacity = signal(0.4);
  get bbxOpacity(): number { return this._bbxOpacity(); }
  set bbxOpacity(v: number) { this._bbxOpacity.set(v); }

  // ── Image processing / model ─────────────────────────────────────────────

  private readonly _useInverse = signal(false);
  get useInverse(): boolean { return this._useInverse(); }
  set useInverse(v: boolean) { this._useInverse.set(v); }

  private readonly _useProcessing = signal(false);
  get useProcessing(): boolean { return this._useProcessing(); }
  set useProcessing(v: boolean) { this._useProcessing.set(v); }

  // ── Rendering / navigation ───────────────────────────────────────────────

  // On by default: the compositor tests itself at start-up and falls back to
  // the CPU.
  private readonly _webGPURendering = signal(true);
  get webGPURendering(): boolean { return this._webGPURendering(); }
  set webGPURendering(v: boolean) { this._webGPURendering.set(v); }

  private readonly _resetZoomAfterNavigation = signal(true);
  get resetZoomAfterNavigation(): boolean { return this._resetZoomAfterNavigation(); }
  set resetZoomAfterNavigation(v: boolean) { this._resetZoomAfterNavigation.set(v); }

  // ── Active tool ──────────────────────────────────────────────────────────

  private readonly _selectedTool = signal<Tool>(Tools.PEN);

  /** The active tool. Writing it emits `toolChanged$`. */
  get selectedTool(): Tool {
    return this._selectedTool();
  }
  set selectedTool(tool: Tool) {
    const previous = this._selectedTool();
    if (previous === tool) return;
    // Pan is transient: it is never the tool Alt swaps back to.
    if (previous !== Tools.PAN && tool !== Tools.PAN) {
      this._previousTool.set(previous);
    }
    this._selectedTool.set(tool);
    this.toolChanged$.next(tool);
  }

  /** The tool used before the current one, ignoring pan. */
  private readonly _previousTool = signal<Tool>(Tools.ERASER);

  /** Flip between the current tool and the previous one. */
  public swapToPreviousTool(): void {
    this.selectedTool = this._previousTool();
  }

  public activatePanMode() {
    this.activateTemporaryTool(Tools.PAN);
  }

  /** Switch to `tool` for the length of a gesture; `restoreLastTool` ends it. */
  public activateTemporaryTool(tool: Tool) {
    this._lastTool = this.selectedTool;
    this.selectedTool = tool;
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

  public isSelectTool(): boolean {
    return this.selectedTool === Tools.SELECT;
  }

  public isVectorizeTool(): boolean {
    return this.selectedTool === Tools.VECTORIZE;
  }

  public isSkeletonizeTool(): boolean {
    return this.selectedTool === Tools.SKELETONIZE;
  }

  public isEllipseTool(): boolean {
    return this.selectedTool === Tools.ELLIPSE;
  }

  public isShapeTool(): boolean {
    return this.selectedTool === Tools.RECT || this.isEllipseTool();
  }

  /** The tools that act on the SVG layer (Select, Path, Box, Ellipse, Node).
   *  Not Vectorize, which acts on the masks. */
  public isVectorTool(): boolean {
    return (
      this.isPathTool() ||
      this.isNodeTool() ||
      this.isSelectTool() ||
      this.isShapeTool()
    );
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
