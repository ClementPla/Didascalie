import { BehaviorSubject } from "rxjs";
import { OpenCVService } from "../../../../Services/open-cv.service";
import { EditorService } from "../services/editor.service";
import { CanvasManagerService } from "./service/canvas-manager.service";
import { StateManagerService } from "./service/state-manager.service";

export interface ToolContext {
  // Services
  canvasManager: CanvasManagerService;
  stateService: StateManagerService;
  editorService: EditorService;
  
  // Scoped Data
  color: string;
  
  // Coordinate Helper (The "Bridge" to ZoomPanService)
  getCoords: (event: MouseEvent | Point2D) => Point2D;
  swapMarkers: () => void;
  singleDrawRequest: (ctx: OffscreenCanvasRenderingContext2D | null) => void;
  redrawRequest: () => void;
  updatePreviewPoints: (points: Point2D[]) => void;
}


export interface DrawingTool {
    start(event: MouseEvent, context: ToolContext): void;
    draw(event: MouseEvent, context: ToolContext): void;
    end(context: ToolContext): void; 
}

export interface UndoRedoCanvasElement {
  data: OffscreenCanvas | OffscreenCanvas[];
  index: number;
}

export interface Point2D {
    x: number;
    y: number;
}

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}


export interface Viewbox {
    xmin: number;
    ymin: number;
    xmax: number;
    ymax: number;
}