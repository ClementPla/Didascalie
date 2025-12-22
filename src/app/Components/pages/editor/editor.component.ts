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
import { LabelsService } from '../../../Services/Labels/labels.service';
import {
  NavigationService,
  ProgressInfo,
} from '../../../Services/Navigation/navigation.service';
import { UIStateService } from '../../../Services/uistate.service';
import { ProjectService } from '../../../Services/ProjectService/project.service';
import { ZoomPanService } from './drawable-canvas/service/zoom-pan.service';
import { CanvasManagerService } from './drawable-canvas/service/canvas-manager.service';
import { KeyboardShortcutService } from './services/keyboard-shortcut.service';
import {
  DownloadProgress,
  TauriEventService,
} from '../../../Services/TauriEvent/';
import { IOService } from '../../../Services/io.service';
import { OrchestratorService } from './drawable-canvas/service/orchestrator.service';
// Core
import { Tools } from '../../../Core/tools';
import { MultiframesService } from '../../../Services/multiframes.service';

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
  @ViewChild(MultiFramesOptionsComponent)
  multiFramesOptions: MultiFramesOptionsComponent;
  @ViewChild('quickAccessMenu') quickAccessMenu: QuickAccessMenuComponent;

  public viewPortSize = 800;
  public displayDownloadDialog = false;
  public downloadProgress = 0;
  public progressItems: MeterItem[] = [];

  private destroy$ = new Subject<void>();
  private mousePosition: { x: number; y: number } = { x: 0, y: 0 };

  constructor(
    private editorService: EditorService,
    private labelService: LabelsService,
    private uiStateService: UIStateService,
    private navigationService: NavigationService,
    public projectService: ProjectService,
    private zoomPanService: ZoomPanService,
    private canvasManagerService: CanvasManagerService,
    private keyboardService: KeyboardShortcutService,
    private tauriEvents: TauriEventService,
    private ioService: IOService,
    private orchestratorService: OrchestratorService,
    private multiframeService: MultiframesService
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
      .subscribe((action) => this.handleShortcutAction(action));

    this.ioService.requestedReload
      .pipe(takeUntil(this.destroy$))
      .subscribe((shouldReload) => {
        if (shouldReload) {
          this.loadCanvas(shouldReload);
        }
      });

    this.tauriEvents.downloadProgress$
      .pipe(takeUntil(this.destroy$))
      .subscribe((info) => this.handleDownloadProgress(info));

    this.tauriEvents.segmentationStarted$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.uiStateService.setLoading(
          true,
          'Performing mask segmentation (first call may take longer)'
        );
      });

    this.tauriEvents.segmentationCompleted$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.uiStateService.endLoading();
      });

    this.navigationService.progress$
      .pipe(takeUntil(this.destroy$))
      .subscribe((progress) => this.updateProgressDisplay(progress));
  }

  private handleShortcutAction(action: string) {
    const actionHandlers: Record<string, () => void | Promise<void>> = {
      selectPen: () => this.editorService.selectTool(Tools.PEN),
      selectEraser: () => this.editorService.selectTool(Tools.ERASER),
      selectLasso: () => this.editorService.selectTool(Tools.LASSO),
      selectLassoEraser: () =>
        this.editorService.selectTool(Tools.LASSO_ERASER),
      selectLine: () => this.editorService.selectTool(Tools.LINE),
      selectPan: () => this.editorService.selectTool(Tools.PAN),

      undo: () => this.editorService.requestUndo(),
      redo: () => this.editorService.requestRedo(),

      toggleAllVisibility: () => {
        this.labelService.switchVisibilityAllSegLabels();
        this.editorService.requestCanvasRedraw();
      },
      nextLabel: () => this.cycleToNextLabel(),
      toggleEdges: () => {
        this.editorService.edgesOnly = !this.editorService.edgesOnly;
        this.editorService.requestCanvasRedraw();
      },
      toggleImageProcessing: () => {
        this.editorService.useProcessing = !this.editorService.useProcessing;
        this.editorService.requestCanvasRedraw();
      },
      togglePostProcessing: () => this.togglePostProcessing(),
      zoomIn: () => this.zoomPanService.zoomIn(1.2),
      zoomOut: () => this.zoomPanService.zoomOut(1.2),

      save: async () => {
        await this.save();
      },
      nextImage: () => this.navigateNext(),
      previousImage: () => this.navigatePrevious(),

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
      await this.navigationService.loadCurrentImage(reload);
      this.orchestratorService.requestRedraw();
      this.updateProgressDisplay(this.navigationService.getProgress());
    } catch (error) {
      console.error('Error loading canvas:', error);
    }
  }

  public async navigateNext(): Promise<void> {
    this.uiStateService.setLoading(true, 'Loading next image');

    const result = await this.navigationService.navigate('next');

    if (result) {
      this.handleNavigationSuccess();
    }

    this.uiStateService.endLoading();
  }

  public async navigatePrevious(): Promise<void> {
    this.uiStateService.setLoading(true, 'Loading previous image');

    const result = await this.navigationService.navigate('previous');

    if (result) {
      this.handleNavigationSuccess();
    }

    this.uiStateService.endLoading();
  }

  public async changedOfFrame(newFrame: number): Promise<void> {
    const result = await this.navigationService.navigateToFrame(newFrame);

    if (result) {
      this.orchestratorService.requestRedraw();
    } else {
      this.syncFrameFromService();
    }
  }

  private resetFrameIfNeeded() {
    if (this.multiFramesOptions) {
      this.multiFramesOptions.currentFrame = 0;
    }
  }

  public async save(): Promise<boolean> {
    const success = await this.navigationService.save();
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
      this.editorService.eraserPostProcess =
        !this.editorService.eraserPostProcess;
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

    this.progressItems = [
      {
        label: `Current image: ${progress.imageName} - ${progress.currentIndex} / ${progress.total} images done`,
        value: progress.percentage,
        color: 'var(--p-primary-color)',
      },
    ];
  }

  get isMultiframeActive(): boolean {
    return this.navigationService.isMultiframeActive;
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
    return this.uiStateService.isLoading;
  }

  get loadingStatus(): string {
    return this.uiStateService.loadingStatus;
  }

  private handleNavigationSuccess(): void {
    this.resetFrameIfNeeded();
    this.orchestratorService.requestRedraw();
  }

  private syncFrameFromService(): void {
    if (this.multiFramesOptions && this.multiframeService.activeGroup) {
      // Get the actual current frame index from the service
      const currentImageName =
        this.projectService.imagesName[this.projectService.activeIndex!];
      const frames = this.multiframeService.groupedFrames.get(
        this.multiframeService.activeGroup
      );
      if (frames) {
        const frameIndex = frames.findIndex(
          (f) => f.includes(currentImageName) || currentImageName.includes(f)
        );
        if (frameIndex !== -1) {
          this.multiFramesOptions.currentFrame = frameIndex;
        }
      }
    }
  }
}
