import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  ViewChild,
  HostListener,
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EditorService } from '../../../../../Services/UI/editor.service';
import { ViewService } from '../../../../../Services/UI/view.service';
import { LabelsService } from '../../../../../Services/Project/labels.service';
import { Point2D, Viewbox } from '../../../../../Core/interface';
import { Button } from 'primeng/button';
import { OpenCVService } from '../../../../../Services/open-cv.service';
import { ImageProcessingService } from '../service/image-processing.service';
import { ProjectService } from '../../../../../Services/Project/project.service';
import { SVGElementsComponent } from './svgelements/svgelements.component';
import { ZoomPanService } from '../service/zoom-pan.service';
import { CanvasManagerService } from '../service/canvas-manager.service';
import { StateManagerService } from '../service/state-manager.service';
import { DrawService } from '../service/draw.service';
import { UndoRedoService } from '../service/undo-redo.service';
import { PostProcessService } from '../service/post-process.service';

/**
 *
 * DrawableCanvasComponent is a component that allows the user to draw on a canvas.
 * It is tightly coupled with the EditorService, ViewService, LabelsService, ImageProcessingService, OpenCVService, ProjectService, ZoomPanService, CanvasManagerService, StateManagerService, DrawService, UndoRedoService, and PostProcessService.
 * Refactoring idea: create an NgModule containing the ImageProcessingService, ZoomPanService, CanvasManagerService, StateManagerService, DrawService, UndoRedoService, and PostProcessService, and import it in the DrawableCanvasComponent.
 *
 */

@Component({
  selector: 'app-drawable-canvas',
  standalone: true,
  imports: [CommonModule, FormsModule, Button, SVGElementsComponent],
  templateUrl: './drawable-canvas.component.html',
  styleUrl: './drawable-canvas.component.scss',
})
export class DrawableCanvasComponent implements AfterViewInit {
  public cursor: Point2D = { x: 25, y: 25 };
  public currentPixel: Point2D = { x: 0, y: 0 };
  public viewBox: Viewbox = { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
  public isFullscreen: boolean = false;
  public rulerSize: number = 16;
  public isImageLoaded: boolean = false;
  private ctxImage: CanvasRenderingContext2D | null = null;
  private ctxLabel: CanvasRenderingContext2D;
  public canvasWidth = 1;
  public canvasHeight = 1;
  public canvasLeft = 0;
  srcImg: string;

  @ViewChild('imageCanvas') public imgCanvas: ElementRef<HTMLCanvasElement>;
  @ViewChild('labelCanvas') public labelCanvas: ElementRef<HTMLCanvasElement>;

  @ViewChild('svg') public svg: SVGElementsComponent;

  image: HTMLImageElement = new Image();

  constructor(
    public editorService: EditorService,
    public viewService: ViewService,
    public labelService: LabelsService,
    protected imageProcessingService: ImageProcessingService,
    protected openCVService: OpenCVService,
    protected projectService: ProjectService,
    public zoomPanService: ZoomPanService,
    private canvasManagerService: CanvasManagerService,
    public stateService: StateManagerService,
    private drawService: DrawService,
    private undoRedoService: UndoRedoService,
    private postProcessService: PostProcessService,
    private changeDetectorRef: ChangeDetectorRef
  ) {
    this.initSubscriptions();
    this.loadImage('assets/imgs/hue_gradient.png');
  }

  private initSubscriptions() {
    this.zoomPanService.redrawRequest.subscribe((value) => {
      if (value) {
        this.redrawAllCanvas();
      }
    });

    this.canvasManagerService.requestRedraw.subscribe((value) => {
      if (value) {
        this.drawService.refreshAllColors();
        this.redrawAllCanvas();
      }
    });

    this.drawService.redrawRequest.subscribe((value) => {
      if (value) {
        this.redrawAllCanvas();
      }
    });

    this.drawService.singleDrawRequest.subscribe((ctx) => {
      if (ctx) {
        this.ctxLabel.drawImage(ctx.canvas, 0, 0);
      }
    });

    this.undoRedoService.redrawRequest.subscribe((value) => {
      if (value) {
        this.redrawAllCanvas();
      }
    });
  }

  public async ngAfterViewInit() {
    this.ctxImage = this.imgCanvas.nativeElement.getContext('2d', {
      alpha: false,
    })!;
    this.ctxLabel = this.labelCanvas.nativeElement.getContext('2d', {
      alpha: true,
    })!;

    this.zoomPanService.setContext(this.imgCanvas.nativeElement);
    this.undoRedoService.empty();
    if (this.projectService.activeImage) {
      this.loadImage(this.projectService.activeImage);
    }
  }

  goFullScreen() {
    //
  }

  @HostListener('window:resize')
  public resizedWindow() {
    this.resizeCanvas();
  }

  public resizeCanvas() {
    let aspectRatio = this.stateService.width / this.stateService.height;

    const parentElement =
      this.imgCanvas.nativeElement.parentElement?.parentElement;
    if (!parentElement) {
      console.error('Parent element not found');
      return;
    }
    const parentWidth = parentElement?.clientWidth || 0;
    const parentHeight = parentElement?.clientHeight || 0;
    // Fill the parent element with the canvas without overflow or stretching
    // Maintain aspect ratio
    let newWidth = parentWidth;
    let newHeight = parentWidth / aspectRatio;

    if (newHeight > parentHeight) {
      newHeight = parentHeight;
      newWidth = parentHeight * aspectRatio;
    }

    this.canvasWidth = newWidth;
    this.canvasHeight = newHeight;

    this.changeDetectorRef.detectChanges();

    const canvasRect = this.imgCanvas.nativeElement.getBoundingClientRect();

    this.canvasLeft =
      canvasRect.left - parentElement.getBoundingClientRect().left;
  }
  public initializeDimensions() {
    this.stateService.setWidthAndHeight(this.image.width, this.image.height);
    this.imgCanvas.nativeElement.width = this.stateService.width; // This is the canvas with the main image
    this.imgCanvas.nativeElement.height = this.stateService.height;

    this.labelCanvas.nativeElement.width = this.stateService.width; // This is the displayed canvas
    this.labelCanvas.nativeElement.height = this.stateService.height;

    this.svg.setViewBox({
      x: 0,
      y: 0,
      width: this.stateService.width,
      height: this.stateService.height,
    });

    this.resizeCanvas();
  }

  public getCursorSize() {
    if (!this.ctxLabel) {
      return 0;
    }
    const rect = this.ctxLabel.canvas.getBoundingClientRect();
    return (
      ((this.editorService.lineWidth * rect.width) / this.stateService.width) *
      this.zoomPanService.getScale()
    );
  }

  public getLassoPointsToPolygon() {
    if (this.drawService.lassoPoints.length < 3) {
      return '';
    }
    let points = '';
    for (let i = 0; i < this.drawService.lassoPoints.length; i++) {
      points +=
        this.drawService.lassoPoints[i].x +
        ',' +
        this.drawService.lassoPoints[i].y +
        ' ';
    }
    return points;
  }

  public async loadImage(image: string) {
    this.isImageLoaded = false;
    this.srcImg = image;
    return this.reload();
  }
  public wheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.ctrlKey) {
      this.editorService.lineWidth += event.deltaY > 0 ? -2 : 2;
      this.editorService.lineWidth = Math.max(1, this.editorService.lineWidth);
      return;
    }
    this.stateService.recomputeCanvasSum = false;

    this.zoomPanService.wheel(event);
    // Transform mouse coordinates to canvas coordinates
    this.currentPixel = this.zoomPanService.getImageCoordinates(event);
    this.viewBox = this.zoomPanService.getViewBox();
  }

  public mouseDown(event: MouseEvent | TouchEvent) {
    if ('TouchEvent' in window && event instanceof TouchEvent) {
      event = this.convertTouchEvent(event);
    }
    event = event as MouseEvent;
    if (event.button == 1) {
      this.editorService.activatePanMode();
    }
    if (this.editorService.canPan()) {
      this.stateService.recomputeCanvasSum = false;
      this.zoomPanService.startDrag(event);
    } else {
      this.stateService.recomputeCanvasSum = true;
      this.drawService.startDraw(event);
      this.drawService.draw(event);
    }
  }

  convertTouchEvent(event: TouchEvent): MouseEvent {
    event.preventDefault();
    event.stopPropagation();
    let touch: Touch | null = null;
    if (event.type == 'touchend') {
      touch = event.changedTouches[0];
    } else {
      touch = event.touches[0];
    }

    if (!touch) {
      throw new Error('No touch event found');
    }

    let type: string = 'mousemove';

    switch (event.type) {
      case 'touchstart':
        type = 'mousedown';
        break;
      case 'touchmove':
        type = 'mousemove';
        break;
      case 'touchend':
        type = 'mouseup';
        break;
      case 'touchcancel':
        type = 'mouseup';
        break;
    }

    return new MouseEvent(type, {
      clientX: touch.clientX,
      clientY: touch.clientY,
      screenX: touch.screenX,
      screenY: touch.screenY,
      bubbles: true,
      cancelable: true,
      button: undefined,
    });
  }

  public mouseMove(event: MouseEvent | TouchEvent) {
    if ('TouchEvent' in window && event instanceof TouchEvent) {
      event = this.convertTouchEvent(event);
    }
    event = event as MouseEvent;
    event.preventDefault();
    const rect = this.ctxLabel.canvas.getBoundingClientRect();

    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    this.currentPixel = this.zoomPanService.getImageCoordinates(event);
    // We store the current pixel in the zoomPanService
    this.zoomPanService.currentPixel = this.currentPixel;

    this.cursor = { x: mouseX, y: mouseY };
    if (this.editorService.canPan()) {
      this.stateService.recomputeCanvasSum = false;
      this.zoomPanService.drag(event);
      this.viewBox = this.zoomPanService.getViewBox();
    } else {
      this.stateService.recomputeCanvasSum = true;
      this.drawService.draw(event);
    }
  }

  public async mouseUp(event: MouseEvent | TouchEvent) {
    if ('TouchEvent' in window && event instanceof TouchEvent) {
      event = this.convertTouchEvent(event);
    }
    event = event as MouseEvent;
    if (event.button == 1) {
      this.editorService.restoreLastTool();
    }
    this.zoomPanService.endDrag();

    if (this.editorService.canPan()) {
      return;
    }

    await this.drawService.endDraw();
  }

  public redrawAllCanvas() {
    // Redraw the main image
    this.viewBox = this.zoomPanService.getViewBox();
    this.svg.setViewBox(this.zoomPanService.getSVGViewBox());

    if (!this.image.complete || this.image.naturalWidth === 0) {
      console.error('Image is not fully loaded or is invalid');
      return;
    }

    if (!this.ctxImage) {
      return;
    }

    const scale = this.zoomPanService.getScale();
    const offset = this.zoomPanService.getOffset();
    // This is the canvas with the main image
    this.ctxImage.resetTransform();
    this.drawService.clearCanvas(this.ctxImage);
    this.ctxImage.translate(Math.floor(offset.x), Math.floor(offset.y));
    this.ctxImage.scale(scale, scale);
    let image = this.imageProcessingService.getCurrentCanvas();
    // Remove antialiasing from ctxLabel
    this.ctxImage.imageSmoothingEnabled = false;
    this.ctxImage.drawImage(
      image,
      0,
      0,
      this.stateService.width,
      this.stateService.height
    );
    // This is the canvas with the marker drawings
    this.drawService.clearCanvas(this.ctxLabel);

    this.ctxLabel.resetTransform();
    this.ctxLabel.translate(Math.floor(offset.x), Math.floor(offset.y));
    this.ctxLabel.scale(scale, scale);
    this.canvasManagerService.ensurePixelPerfectDrawing(this.ctxLabel);

    if (this.stateService.recomputeCanvasSum) {
      this.canvasManagerService.computeCombinedCanvas();
      this.stateService.recomputeCanvasSum = false;
    }
    this.ctxLabel.drawImage(
      this.canvasManagerService.getCombinedCanvas(),
      0,
      0
    );
  }

  public reload(): Promise<void> {
    if (this.ctxLabel) {
      this.ctxLabel.imageSmoothingEnabled = false;
    }

    return new Promise<void>((resolve, reject) => {
      this.image.onload = () => {
        this.stateService.recomputeCanvasSum = true;
        this.postProcessService.featuresExtracted = false;

        this.imageProcessingService.setImage(this.image);
        this.drawService.clearCanvas(this.ctxLabel);
        this.drawService.clearCanvas(this.ctxImage!);

        this.initializeDimensions();

        this.undoRedoService.empty();
        this.redrawAllCanvas();
        this.isImageLoaded = true;
        resolve();
      };
      this.image.onerror = (error) => {
        console.error('Error loading image:', error);
        reject(error);
      };
      this.image.src = this.srcImg;
    });
  }

  public loadCanvas(data: string, index: number) {
    this.canvasManagerService.loadCanvas(data, index);
  }

  public loadAllCanvas(masks: string[]) {
    this.canvasManagerService.loadAllCanvas(masks);
  }

  public switchFullScreen() {
    this.isFullscreen = !this.isFullscreen;
    if (this.isFullscreen) {
    } else {
      this.zoomPanService.resetZoomAndPan(true, true);
    }
  }
  public getCSSFilterEdge(): string {
    return this.editorService.edgesOnly
      ? 'drop-shadow( 1px  0px 0px black) drop-shadow(-1px  0px 0px black) drop-shadow( 0px  1px 0px black) drop-shadow( 0px -1px 0px black)'
      : '';
  }

  public getCursorStyle() {
    if (!this.ctxLabel) {
      return {};
    }
    const cursorSize = this.getCursorSize();
    if (cursorSize <= 0) {
      return {};
    }

    const style = {
      'left.px': this.cursor.x,
      'top.px': this.cursor.y,
      'width.px': cursorSize,
      'border-color': this.labelService.activeLabel?.color,
    };
    //
    return style;

    return "{'left.px': cursor.x, 'top.px': cursor.y, 'width.px': getCursorSize(), 'border-color': labelService.activeLabel?.color}";
  }
}
