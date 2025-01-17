import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  ElementRef,
  ViewChild,
} from '@angular/core';

import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { EditorService } from '../../../../Services/UI/editor.service';
import { ViewService } from '../../../../Services/UI/view.service';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { Point2D, Viewbox } from '../../../../Core/interface';
import { Button } from 'primeng/button';
import { OpenCVService } from '../../../../Services/open-cv.service';
import { ImageProcessingService } from '../service/image-processing.service';
import { ProjectService } from '../../../../Services/Project/project.service';
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
    private cdr: ChangeDetectorRef,
    private postProcessService: PostProcessService
  ) {
    this.initSubscriptions();
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
      await this.loadImage(this.projectService.activeImage);
    }
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

  public loadImage(image: Promise<string>) {
    this.isImageLoaded = false;
    return image.then((img) => {
      this.srcImg = img;
      this.reload();
      this.cdr.detectChanges();

    });
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

  public mouseDown(event: MouseEvent) {
    if (event.button == 1) {
      this.editorService.activatePanMode();
    }
    if (this.editorService.canPan()) {
      this.stateService.recomputeCanvasSum = false;
      this.zoomPanService.startDrag();
    } else {
      this.stateService.recomputeCanvasSum = true;
      this.drawService.startDraw().then(() => {
        this.drawService.draw(event);
      });
    }
  }

  public mouseMove(event: MouseEvent) {
    const rect = this.ctxLabel.canvas.getBoundingClientRect();
    // Transform mouse coordinates to canvas coordinates
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    this.currentPixel = this.zoomPanService.getImageCoordinates(event);

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

  public async mouseUp($event: MouseEvent) {
    if ($event.button == 1) {
      this.editorService.restoreLastTool();
    }

    if (this.editorService.canPan()) {
      this.zoomPanService.endDrag();
    } else {
      await this.drawService.endDraw();
    }
  }

  public redrawAllCanvas() {
    // Redraw the main image
    this.viewBox = this.zoomPanService.getViewBox();
    this.svg.setViewBox(this.zoomPanService.getSVGViewBox());

    if (!this.image.complete || this.image.naturalWidth === 0) {
      console.error('Image is not fully loaded or is invalid');
      return;
    }

    // Redraw the main image
    if (this.ctxImage == null) {
      this.ctxImage = this.imgCanvas.nativeElement.getContext('2d', {
        alpha: false,
      })!;
    }
    if (!this.ctxImage) {
      console.error('Failed to get 2D context');
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

    this.ctxLabel.imageSmoothingEnabled = false;
    this.ctxLabel.filter = 'url(#remove-alpha)';
    if (this.stateService.recomputeCanvasSum) {
      this.canvasManagerService.computeCombinedCanvas();
      this.stateService.recomputeCanvasSum = false;
    }

    this.ctxLabel.imageSmoothingEnabled = false;
    this.ctxLabel.drawImage(
      this.canvasManagerService.getCombinedCanvas(),
      0,
      0
    );

    this.ctxLabel.globalAlpha = 1;
  }

  public reload(): void {
    this.image.src = this.srcImg;

    this.image.onload = () => {
      this.stateService.recomputeCanvasSum = true;
      this.postProcessService.featuresExtracted = false;

      this.imageProcessingService.setImage(this.image);
      this.drawService.clearCanvas(this.ctxLabel);
      this.drawService.clearCanvas(this.ctxImage!);

      this.initializeDimensions();

      this.canvasManagerService.initCanvas();

      this.undoRedoService.empty();
      this.viewService.endLoading();
      this.redrawAllCanvas();

      requestAnimationFrame(() => {
        this.isImageLoaded = true;
      });
    };
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
}
