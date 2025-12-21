// editor.component.ts
import {
  AfterViewInit,
  Component,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

// PrimeNG
import { ToolbarModule } from 'primeng/toolbar';
import { PanelModule } from 'primeng/panel';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { MeterGroupModule, MeterItem } from 'primeng/metergroup';
import { DialogModule } from 'primeng/dialog';
import { ProgressBarModule } from 'primeng/progressbar';

// Components
import { DrawableCanvasComponent } from './drawable-canvas/component/drawable-canvas.component';
import { ToolbarComponent } from './toolbar/toolbar.component';
import { LabelsComponent } from './labels/labels.component';
import { ToolSettingComponent } from './tool-setting/tool-setting.component';
import { MultiFramesOptionsComponent } from './multi-frames-options/multi-frames-options.component';
import { QuickAccessMenuComponent } from './quick-access-menu/quick-access-menu.component';

// Services
import { EditorService } from './services/editor.service';
import { LabelsService } from '../../../Services/Project/labels.service';
import { ViewService, ProgressInfo } from '../../../Services/UI/view.service';
import { ProjectService } from '../../../Services/ProjectService/project.service';
import { ZoomPanService } from './drawable-canvas/service/zoom-pan.service';
import { CanvasManagerService } from './drawable-canvas/service/canvas-manager.service';
import { KeyboardShortcutService } from './services/keyboard-shortcut.service';
import { DownloadProgress, TauriEventService } from '../../../Services/tauri-event.service';
import { IOService } from '../../../Services/Project/io.service';

// Core
import { Tools } from '../../../Core/tools';

@Component({
  selector: 'app-editor',
  imports: [
    CommonModule,
    FormsModule,
    SliderModule,
    ButtonModule,
    ToolbarModule,
    PanelModule,
    TooltipModule,
    ToggleSwitchModule,
    MeterGroupModule,
    DialogModule,
    ProgressBarModule,
    DrawableCanvasComponent,
    ToolbarComponent,
    LabelsComponent,
    ToolSettingComponent,
    MultiFramesOptionsComponent,
    QuickAccessMenuComponent,
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
})
export class EditorComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(DrawableCanvasComponent) canvas: DrawableCanvasComponent;
  @ViewChild(MultiFramesOptionsComponent) multiFramesOptions: MultiFramesOptionsComponent;
  @ViewChild('quickAccessMenu') quickAccessMenu: QuickAccessMenuComponent;

  public viewPortSize = 800;
  public displayDownloadDialog = false;
  public downloadProgress = 0;
  public progressItems: MeterItem[] =  [];

  private destroy$ = new Subject<void>();
  private mousePosition: { x: number; y: number } = { x: 0, y: 0 };

  constructor(
    private editorService: EditorService,
    private labelService: LabelsService,
    private viewService: ViewService,
    public projectService: ProjectService,
    private zoomPanService: ZoomPanService,
    private canvasManagerService: CanvasManagerService,
    private keyboardService: KeyboardShortcutService,
    private tauriEvents: TauriEventService,
    private ioService: IOService
  ) {}

  async ngOnInit() {
    await this.tauriEvents.initialize();
    this.initSubscriptions();
  }

  ngAfterViewInit() {
    this.canvasManagerService.initCanvas();
    this.loadCanvas(true);

    if (this.multiFramesOptions) {
      this.multiFramesOptions._isLoaded = true;
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private initSubscriptions() {
    this.keyboardService.action$
      .pipe(takeUntil(this.destroy$))
      .subscribe(action => this.handleShortcutAction(action));

    this.ioService.requestedReload
      .pipe(takeUntil(this.destroy$))
      .subscribe(shouldReload => {
        if (shouldReload) {
          this.loadCanvas(shouldReload);
        }
      });

    this.tauriEvents.downloadProgress$
      .pipe(takeUntil(this.destroy$))
      .subscribe(info => this.handleDownloadProgress(info));

    this.tauriEvents.segmentationStarted$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.viewService.setLoading(true, 'Performing mask segmentation (first call may take longer)');
      });

    this.tauriEvents.segmentationCompleted$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.viewService.endLoading();
      });

    this.viewService.progress$
      .pipe(takeUntil(this.destroy$))
      .subscribe(progress => this.updateProgressDisplay(progress));
  }

  private handleShortcutAction(action: string) {
    const actionHandlers: Record<string, () => void | Promise<void>> = {
      'selectPen': () => this.editorService.selectTool(Tools.PEN),
      'selectEraser': () => this.editorService.selectTool(Tools.ERASER),
      'selectLasso': () => this.editorService.selectTool(Tools.LASSO),
      'selectLassoEraser': () => this.editorService.selectTool(Tools.LASSO_ERASER),
      'selectLine': () => this.editorService.selectTool(Tools.LINE),
      'selectPan': () => this.editorService.selectTool(Tools.PAN),

      'undo': () => this.editorService.requestUndo(),
      'redo': () => this.editorService.requestRedo(),

      'toggleAllVisibility': () => {
        this.labelService.switchVisibilityAllSegLabels();
        this.editorService.requestCanvasRedraw();
      },
      'nextLabel': () => this.cycleToNextLabel(),
      'toggleEdges': () => {
        this.editorService.edgesOnly = !this.editorService.edgesOnly;
        this.editorService.requestCanvasRedraw();
      },
      'toggleImageProcessing': () => {
        this.editorService.useProcessing = !this.editorService.useProcessing;
        this.editorService.requestCanvasRedraw();
      },
      'togglePostProcessing': () => this.togglePostProcessing(),
      'zoomIn': () => this.zoomPanService.zoomIn(1.2),
      'zoomOut': () => this.zoomPanService.zoomOut(1.2),

      'save': async () => { await this.save(); },
      'nextImage': () => this.navigateNext(),
      'previousImage': () => this.navigatePrevious(),

      'panMode:start': () => this.editorService.activatePanMode(),
      'panMode:end': () => this.editorService.restoreLastTool(),
      'quickMenu:start': () => {
        this.quickAccessMenu.position = this.mousePosition;
        this.quickAccessMenu.toggleOpen();
      },
      'quickMenu:end': () => {},
    };

    const handler = actionHandlers[action];
    if (handler) {
      handler();
    }
  }

  public async loadCanvas(reload: boolean = true) {
    if (!this.canvas || !this.projectService.activeImage) {
      console.warn('Canvas or active image not available');
      return;
    }

    try {
      await this.viewService.loadCurrentImage(reload);
      this.canvas.redrawAllCanvas();
      this.updateProgressDisplay(this.viewService.getProgress());
    } catch (error) {
      console.error('Error loading canvas:', error);
    }
  }

  public async navigateNext() {
    const success = await this.viewService.navigate('next');
    if (success) {
      this.resetFrameIfNeeded();
      this.canvas.redrawAllCanvas();
    }
  }

  public async navigatePrevious() {
    const success = await this.viewService.navigate('previous');
    if (success) {
      this.resetFrameIfNeeded();
      this.canvas.redrawAllCanvas();
    }
  }

  public async changedOfFrame(newFrame: number) {
    const success = await this.viewService.navigateToFrame(newFrame);
    if (success) {
      this.canvas.redrawAllCanvas();
    } else {
      this.resetFrameIfNeeded();
    }
  }

  private resetFrameIfNeeded() {
    if (this.multiFramesOptions) {
      this.multiFramesOptions.currentFrame = 0;
    }
  }

  public async save(): Promise<boolean> {
    const success = await this.viewService.save();
    if (success) {
      console.log('Annotations saved');
    }
    return success;
  }

  private cycleToNextLabel() {
    const currentIndex = this.labelService.getActiveIndex();
    const labels = this.labelService.listSegmentationLabels;
    const nextIndex = (currentIndex + 1) % labels.length;
    this.labelService.activeLabel = labels[nextIndex];
  }

  private togglePostProcessing() {
    if (this.editorService.isDrawingTool()) {
      this.editorService.penPostProcess = !this.editorService.penPostProcess;
    }
    if (this.editorService.isEraser()) {
      this.editorService.eraserPostProcess = !this.editorService.eraserPostProcess;
    }
  }

  public updateMousePosition(event: MouseEvent) {
    this.mousePosition = { x: event.clientX, y: event.clientY };
  }

  private handleDownloadProgress(info: DownloadProgress) {
    this.displayDownloadDialog = !info.downloaded;
    this.downloadProgress = info.progress;
  }

  private updateProgressDisplay(progress: ProgressInfo | null) {
    if (!progress) {
      this.progressItems = [];
      return;
    }

    this.progressItems = [{
      label: `Current image: ${progress.imageName} - ${progress.currentIndex} / ${progress.total} images done`,
      value: progress.percentage,
      color: 'var(--p-primary-color)',
    }];
  }

  get isMultiframeActive(): boolean {
    return this.viewService.isMultiframeActive;
  }

  get totalImages(): number {
    return this.projectService.getTotalImages();
  }

  get activeImageName(): string | null {
    const index = this.projectService.activeIndex;
    if (index === null) return null;
    return this.projectService.imagesName[index] || null;
  }

  get isLoading(): boolean {
    return this.viewService.isLoading;
  }

  get loadingStatus(): string {
    return this.viewService.loadingStatus;
  }
}