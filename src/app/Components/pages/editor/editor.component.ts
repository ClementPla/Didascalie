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

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [
    DrawableCanvasComponent,
    ButtonModule,
    ToolbarComponent,
    LabelsComponent,
    NgIf,
    PanelModule,
    ToolSettingComponent,
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
})
export class EditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(DrawableCanvasComponent) canvas: DrawableCanvasComponent;
  public viewPortSize: number = 800;
  private subscriptions = new Subscription();

  constructor(
    public projectService: ProjectService,
    private drawService: DrawService,
    private stateService: StateManagerService,
    private editorService: EditorService,
    private labelService: LabelsService,
    public IOService: IOService
  ) {
    this.initializeSubscriptions();
  }

  ngOnInit() {
  }

  ngAfterViewInit() {
    this.loadCanvas();
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

  public async loadCanvas() {
    if (!this.canvas || !this.projectService.activeImage) {
      console.warn('Canvas or active image not available');
      return;
    }

    try {
      await this.canvas.loadImage(this.projectService.activeImage);
      await this.IOService.load();

      this.drawService.refreshAllColors();
      this.stateService.recomputeCanvasSum = true;

      // Finally reload the canvas and wait for the next frame
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          this.canvas.redrawAllCanvas();
          resolve();
        });
      });
    } catch (error) {
      console.error('Error in loadCanvas sequence:', error);
      throw error; // Re-throw to handle at caller level if needed
    }
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
  changeToLasso() {
    this.editorService.selectedTool = Tools.LASSO;
  }

  @HostListener('window:keydown.shift.l')
  changeToLassoEraser() {
    this.editorService.selectedTool = Tools.LASSO_ERASER;
  }

  @HostListener('window:keydown.g')
  changeToPan() {
    this.editorService.selectedTool = Tools.PAN;
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
    const nextIndex = (currentIndex + 1) % this.labelService.listSegmentationLabels.length;
    this.labelService.activeLabel = this.labelService.listSegmentationLabels[nextIndex];
  }
  @HostListener('window:keydown.space', ['$event'])
  togglePostProcessing() {
    this.editorService.autoPostProcess = !this.editorService.autoPostProcess;
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
        return this.projectService.goNext();
      })
      .then(() => {
        this.loadCanvas();
      });
  }




  @HostListener('window:keydown.ArrowLeft', ['$event'])
  async loadPrevious() {
    await this.save()
      .then((hasSaved) => {
        if (!hasSaved) {
          return Promise.reject('Could not save');
        }
        return this.projectService.goPrevious();
      })
      .then(() => {
        this.loadCanvas();
      });
  }
}
