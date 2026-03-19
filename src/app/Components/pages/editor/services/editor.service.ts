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
  public morphoSize: number = 3;
  public redo: Subject<boolean> = new Subject<boolean>();
  public selectedTool: Tool = Tools.PEN;
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

  public webGPURendering: boolean = false;
  public resetZoomAfterNavigation: boolean = true;
  constructor() {}

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
