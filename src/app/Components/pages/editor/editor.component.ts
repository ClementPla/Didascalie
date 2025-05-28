import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  Host,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { DrawableCanvasComponent } from './drawable-canvas/component/drawable-canvas.component';
import { ToolbarModule } from 'primeng/toolbar';

import { ToolbarComponent } from './toolbar/toolbar.component';
import { LabelsComponent } from './labels/labels.component';
import { ProjectService } from '../../../Services/Project/project.service';
import { NgIf } from '@angular/common';
import { HostListener } from '@angular/core';
import { EditorService } from '../../../Services/UI/editor.service';
import { Tools } from '../../../Core/tools';
import { ToolSettingComponent } from './tool-setting/tool-setting.component';
import { LabelsService } from '../../../Services/Project/labels.service';
import { PanelModule } from 'primeng/panel';
import { ButtonModule } from 'primeng/button';
import { IOService } from '../../../Services/Project/io.service';
import { Subscription } from 'rxjs';
import { DrawService } from './drawable-canvas/service/draw.service';
import { StateManagerService } from './drawable-canvas/service/state-manager.service';
import { ViewService } from '../../../Services/UI/view.service';
import { ZoomPanService } from './drawable-canvas/service/zoom-pan.service';
import { TooltipModule } from 'primeng/tooltip';
import { FormsModule } from '@angular/forms';
import { MultiframesService } from '../../../Services/Project/multiframes.service';
import { SliderModule } from 'primeng/slider';
import { CanvasManagerService } from './drawable-canvas/service/canvas-manager.service';
import { InputSwitchModule } from 'primeng/inputswitch';
@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [
    SliderModule,
    DrawableCanvasComponent,
    FormsModule,
    ButtonModule,
    ToolbarComponent,
    ToolbarModule,
    LabelsComponent,
    NgIf,
    PanelModule,
    ToolSettingComponent,
    TooltipModule,
    InputSwitchModule,
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
})
export class EditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(DrawableCanvasComponent) canvas: DrawableCanvasComponent;
  public viewPortSize: number = 800;
  private subscriptions = new Subscription();
  private _isLoaded: boolean = false;
  private _spaceDown: boolean = false;

  currentFrame: number = 0;

  constructor(
    public projectService: ProjectService,
    private drawService: DrawService,
    private stateService: StateManagerService,
    private editorService: EditorService,
    private labelService: LabelsService,
    public IOService: IOService,
    private viewService: ViewService,
    private zoomPanService: ZoomPanService,
    public multiframeService: MultiframesService,
    private canvasManagerService: CanvasManagerService
  ) {}

  ngOnInit() {
    this.initializeSubscriptions();
  }

  ngAfterViewInit() {
    this.canvasManagerService.initCanvas();
    this.loadCanvas(true);
    this._isLoaded = true;
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
  }

  private initializeSubscriptions(): void {
    this.subscriptions.add(
      this.IOService.requestedReload.subscribe({
        next: (shouldReload: boolean) => {
          if (shouldReload) {
            void this.loadCanvas();
          }
        },
        error: (error: Error) => {
          console.error('Reload subscription error:', error);
        },
      })
    );
  }

  async multiFrameChanged() {
    if (!this._isLoaded) {
      return;
    }
    await this.save();
    if (this.multiframeService.activeGroup) {
      const currentFramePath = this.multiframeService.getFrameNameInActiveGroup(
        this.currentFrame
      );
      console.log(currentFramePath);
      if (!currentFramePath) {
        console.warn('Current frame path is not available');
        return;
      }
      const currentFrameName = this.projectService.extractImagesName([
        currentFramePath,
      ])[0];
      const index = this.projectService.imagesName.indexOf(currentFrameName);

      this.projectService.activeIndex = index;
      this.projectService.activeImage =
        await this.multiframeService.getFrameInActiveGroup(this.currentFrame);
    } else {
      this.projectService.activeImage = null;
      this.currentFrame = 0;
    }
    await this.loadCanvas(!this.projectService.groupLabels);
  }

  public async loadCanvas(reload: boolean = true) {
    if (!this.canvas || !this.projectService.activeImage) {
      console.warn('Canvas or active image not available');
      return;
    }

    try {
      await this.canvas.loadImage(this.projectService.activeImage);
    } catch (error) {
      console.error('Error in loadCanvas sequence:', error);
      throw error; // Re-throw to handle at caller level if needed
    }
    if (reload) {
      try {
        await this.IOService.load();
      } catch (error) {
        console.error('Error loading annotations:', error);
        throw error; // Re-throw to handle at caller level if needed
      }
    }
    this.drawService.refreshAllColors();
    this.stateService.recomputeCanvasSum = true;

    // Finally reload the canvas and wait for the next frame
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        this.canvas.redrawAllCanvas();
        resolve();
      });
    });
    this.initSize();
  }

  initSize() {
    if (!this.canvas) {
      return;
    }
    let width = this.canvas.stateService.width;
    let height = this.canvas.stateService.height;
    this.viewPortSize = Math.min(width, height);
  }

  @HostListener('window:keydown.control.z', ['$event'])
  undo(event: KeyboardEvent) {
    this.editorService.requestUndo();
  }
  @HostListener('window:keydown.control.y', ['$event'])
  redo(event: KeyboardEvent) {
    this.editorService.requestRedo();
  }

  @HostListener('window:keydown.e')
  changeToEraser() {
    this.editorService.selectedTool = Tools.ERASER;
  }
  @HostListener('window:keydown.l')
  changeToLine() {
    this.editorService.selectedTool = Tools.LINE;
  }

  @HostListener('window:keydown.shift.l')
  changeToLasso() {
    this.editorService.selectedTool = Tools.LASSO;
  }

  @HostListener('window:keydown.shift.control.e')
  changeToLassoEraser() {
    this.editorService.selectedTool = Tools.LASSO_ERASER;
  }

  @HostListener('window:keydown.g')
  changeToPan() {
    this.editorService.selectedTool = Tools.PAN;
  }

  @HostListener('window:keydown.space')
  togglePanOn() {
    if (!this._spaceDown) {
      this.editorService.activatePanMode();
      this._spaceDown = true;
    }
  }

  @HostListener('window:keyup.space')
  togglePanOff() {
    this.editorService.restoreLastTool();
    this._spaceDown = false;
  }

  @HostListener('window:keydown.p')
  changeToPencil() {
    this.editorService.selectedTool = Tools.PEN;
  }

  @HostListener('window:keydown.tab', ['$event'])
  switchAllVisibility(e: KeyboardEvent) {
    e.preventDefault();
    this.labelService.switchVisibilityAllSegLabels();
    this.editorService.requestCanvasRedraw();
  }

  @HostListener('window:keydown.control.tab', ['$event'])
  nextLabel() {
    const currentIndex = this.labelService.getActiveIndex();
    const nextIndex =
      (currentIndex + 1) % this.labelService.listSegmentationLabels.length;
    this.labelService.activeLabel =
      this.labelService.listSegmentationLabels[nextIndex];
  }
  @HostListener('window:keydown.d', ['$event'])
  togglePostProcessing() {
    if (this.editorService.isDrawingTool()) {
      this.editorService.penPostProcess = !this.editorService.penPostProcess;
    }
    if (this.editorService.isEraser()) {
      this.editorService.eraserPostProcess =
        !this.editorService.eraserPostProcess;
    }
  }

  @HostListener('window:keydown.q', ['$event'])
  toggleImageProcessing() {
    this.editorService.useProcessing = !this.editorService.useProcessing;
    this.editorService.requestCanvasRedraw();
  }

  @HostListener('window:keydown.control.e', ['$event'])
  toggleEdges() {
    this.editorService.edgesOnly = !this.editorService.edgesOnly;
    this.editorService.requestCanvasRedraw();
  }

  @HostListener('window:keydown.control.s', ['$event'])
  async save() {
    await this.projectService.update_reviewed();
    return this.IOService.save();
  }

  @HostListener('window:keydown.ArrowRight', ['$event'])
  async loadNext() {
    await this.save()
      .then((hasSaved) => {
        if (!hasSaved) {
          return Promise.reject('Could not save');
        }
        return this.viewService.goNext();
      })
      .then((success) => {
        if (!success) {
          return Promise.reject('Could not load next frame');
        }
        this.currentFrame = 0; // Reset current frame when loading a new image
        return this.loadCanvas();
      });
  }
  @HostListener('window:keydown.=', ['$event'])
  @HostListener('window:keydown.shift.+', ['$event'])
  @HostListener('window:keydown.+', ['$event'])
  zoomIn() {
    this.zoomPanService.zoomIn(1.2);
  }
  @HostListener('window:keydown.shift._', ['$event'])
  @HostListener('window:keydown.-', ['$event'])
  @HostListener('window:keydown._', ['$event'])
  zoomOut() {
    this.zoomPanService.zoomOut(1.2);
  }

  @HostListener('window:keydown.ArrowLeft', ['$event'])
  async loadPrevious() {
    await this.save()
      .then((hasSaved) => {
        if (!hasSaved) {
          return Promise.reject('Could not save');
        }
        return this.viewService.goPrevious();
      })
      .then((success) => {
        if (!success) {
          return Promise.reject('Could not load previous frame');
        }
        this.currentFrame = 0; // Reset current frame when loading a new image
        return this.loadCanvas();
      });
  }

  @HostListener('window:keydown.ArrowUp', ['$event'])
  nextFrame() {
    if (this.multiframeService.activeGroup) {
      if (
        this.currentFrame + 1 >=
        this.multiframeService.getLengthOfActiveGroup()
      ) {
        this.currentFrame = 0;
      } else {
        this.currentFrame++;
      }
      this.multiFrameChanged();
    }
  }
  @HostListener('window:keydown.ArrowDown', ['$event'])
  previousFrame() {
    if (this.multiframeService.activeGroup) {
      if (this.currentFrame - 1 < 0) {
        this.currentFrame = this.multiframeService.getLengthOfActiveGroup() - 1;
      } else {
        this.currentFrame--;
      }
      this.multiFrameChanged();
    }
  }
  preload(){
    this.viewService.setLoading(true, 'Preloading frames');
    this.multiframeService.cacheActivegroupFrames();
    this.viewService.endLoading();
  }
}
