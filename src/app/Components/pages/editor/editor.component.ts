import {
  AfterViewInit,
  Component,
  NgZone,
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
import { ToggleButtonModule } from 'primeng/togglebutton';
import { PopoverModule } from 'primeng/popover';
import { MeterGroupModule, MeterItem } from 'primeng/metergroup';
import { DialogModule } from 'primeng/dialog';
import { ProgressBarModule } from 'primeng/progressbar';

// Components
import { DrawableCanvasComponent } from './drawable-canvas/component/drawable-canvas.component';
import { EditorToolbarComponent } from './editor-toolbar/editor-toolbar.component';
import { LabelsComponent } from './labels/labels.component';
import { ToolSettingComponent } from './tool-setting/tool-setting.component';
import { MultiFramesOptionsComponent } from './multi-frames-options/multi-frames-options.component';
import { QuickAccessMenuComponent } from './quick-access-menu/quick-access-menu.component';
import { SequenceNavigatorComponent } from './sequence-navigator/sequence-navigator.component';

// Services
import { EditorService } from './services/editor.service';
import { LabelsService } from '../../../Services/Labels/labels.service';
import { SequenceService } from '../../../Services/sequence.service';
import { UIStateService } from '../../../Services/uistate.service';
import { ProjectService } from '../../../Services/ProjectService/project.service';
import { ZoomPanService } from './drawable-canvas/service/zoom-pan.service';
import { CanvasManagerService } from './drawable-canvas/service/canvas-manager.service';
import { KeyboardShortcutService } from './services/keyboard-shortcut.service';
import { StateManagerService } from './drawable-canvas/service/state-manager.service';
import {
  DownloadProgress,
  TauriEventService,
} from '../../../Services/TauriEvent/';
import { IOService } from '../../../Services/io.service';
import { OrchestratorService } from './drawable-canvas/service/orchestrator.service';

// Core
import { Tools } from '../../../Core/tools';
import { VerticalMenuComponent } from "../../../generics/vertical-menu/vertical-menu.component";
import {MenuGroupDirective} from "../../../generics/vertical-menu/menu-group.directive";

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
    ToggleButtonModule,
    PopoverModule,
    MeterGroupModule,
    DialogModule,
    ProgressBarModule,
    DrawableCanvasComponent,
    EditorToolbarComponent,
    LabelsComponent,
    ToolSettingComponent,
    MultiFramesOptionsComponent,
    QuickAccessMenuComponent,
    SequenceNavigatorComponent,
    VerticalMenuComponent,
    MenuGroupDirective
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

  // Collapsible side panels
  public labelsCollapsed = false;
  public settingsCollapsed = false;

  private destroy$ = new Subject<void>();
  private mousePosition: { x: number; y: number } = { x: 0, y: 0 };
  private navInFlight = false;
  public globalReviewed = 0;
  public globalTotal = 0;

  constructor(
    public editorService: EditorService,
    private labelService: LabelsService,
    private uiStateService: UIStateService,
    public sequenceService: SequenceService,
    public projectService: ProjectService,
    private zoomPanService: ZoomPanService,
    private canvasManagerService: CanvasManagerService,
    private stateManagerService: StateManagerService,
    private keyboardService: KeyboardShortcutService,
    private tauriEvents: TauriEventService,
    private ioService: IOService,
    private orchestratorService: OrchestratorService,
    private ngZone: NgZone,
  ) {}

  async ngOnInit() {
    await this.tauriEvents.initialize();
    this.initSubscriptions();
    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('mousemove', this.updateMousePosition.bind(this));
    });
  }

  async ngAfterViewInit() {
    // All initialization happens here, in order
    if (this.projectService.isOpen()) {

      // Now frame should be loaded (loadSequences auto-selects first)
      const frameImage = this.sequenceService.currentFrameImage();

      if (frameImage) {
        await this.initializeCanvas();
      }
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    window.removeEventListener(
      'mousemove',
      this.updateMousePosition.bind(this),
    );
  }

  private initSubscriptions() {
    this.keyboardService.action$
      .pipe(takeUntil(this.destroy$))
      .subscribe((action) => this.handleShortcutAction(action));

    this.ioService.requestedReload
      .pipe(takeUntil(this.destroy$))
      .subscribe((shouldReload) => {
        if (shouldReload) {
          this.loadCanvas();
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
          'Performing mask segmentation (first call may take longer)',
        );
      });

    this.tauriEvents.segmentationCompleted$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.uiStateService.endLoading();
      });
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
      selectPath: () => this.editorService.selectTool(Tools.PATH),
      selectNode: () => this.editorService.selectTool(Tools.NODE),
      selectSelect: () => this.editorService.selectTool(Tools.SELECT),
      selectVectorize: () => this.editorService.selectTool(Tools.VECTORIZE),
      selectSkeletonize: () => this.editorService.selectTool(Tools.SKELETONIZE),

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

  // ==========================================
  // Canvas Initialization & Loading
  // ==========================================

  private async initializeCanvas(): Promise<void> {
    const frameImage = this.sequenceService.currentFrameImage();
    if (!frameImage) {
      console.warn('No frame image available');
      return;
    }

    // Update state manager with frame dimensions
    this.stateManagerService.width = frameImage.frame.width;
    this.stateManagerService.height = frameImage.frame.height;
    // Allocate the per-label masks for this frame's dimensions.
    await this.canvasManagerService.updateCanvasesDimensions();
    // Load annotations
    await this.loadCanvas();
  }

  public async loadCanvas(): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!this.canvas || !frame) {
      console.warn('Canvas or current frame not available');
      return;
    }

    try {
      // Load annotations from database
      await this.ioService.load();

      // Capture initial state for undo/redo
      await this.orchestratorService.captureInitialHistory();

      this.orchestratorService.requestRedraw();
      await this.updateProgressDisplay();
    } catch (error) {
      console.error('Error loading canvas:', error);
    }
  }

  // ==========================================
  // Navigation
  // ==========================================

  public async navigateNext(): Promise<void> {
    // Ignore presses while a navigation is already running, so save→clear→load
    // cycles can't overlap and race the shared canvas.
    if (this.navInFlight) return;
    this.navInFlight = true;
    this.uiStateService.setLoading(true, 'Loading next image');

    try {
      // Save current if dirty
      await this.ioService.saveIfDirty();

      // Navigate to next frame
      const moved = await this.sequenceService.nextSequence();

      if (moved) {
        await this.handleNavigationSuccess();
      }
    } catch (error) {
      console.error('Error navigating to next:', error);
    } finally {
      this.uiStateService.endLoading();
      this.navInFlight = false;
    }
  }

  public async navigatePrevious(): Promise<void> {
    if (this.navInFlight) return;
    this.navInFlight = true;
    this.uiStateService.setLoading(true, 'Loading previous image');

    try {
      // Save current if dirty
      await this.ioService.saveIfDirty();

      // Navigate to previous frame
      const moved = await this.sequenceService.prevSequence();

      if (moved) {
        await this.handleNavigationSuccess();
      }
    } catch (error) {
      console.error('Error navigating to previous:', error);
    } finally {
      this.uiStateService.endLoading();
      this.navInFlight = false;
    }
  }

  public async changedOfFrame(newFrameIndex: number): Promise<void> {
    if (this.navInFlight) return;
    this.navInFlight = true;
    try {
      await this.ioService.saveIfDirty();
      await this.sequenceService.selectFrame(newFrameIndex);
      await this.handleNavigationSuccess();
    } catch (error) {
      console.error('Error changing frame:', error);
    } finally {
      this.navInFlight = false;
    }
  }

  public async selectSequence(sequence: {
    id: number;
    name: string;
    frame_count: number;
    sort_order: number;
  }): Promise<void> {
    if (this.navInFlight) return;
    this.navInFlight = true;
    try {
      await this.ioService.saveIfDirty();
      await this.sequenceService.selectSequence(sequence);
      await this.handleNavigationSuccess();
    } catch (error) {
      console.error('Error selecting sequence:', error);
    } finally {
      this.navInFlight = false;
    }
  }

  /**
   * Jump to a sequence chosen from the sequence-navigator panel.
   */
  public async jumpToSequence(id: number): Promise<void> {
    if (this.sequenceService.sequences().length === 0) {
      await this.sequenceService.loadSequences();
    }
    const sequence = this.sequenceService
      .sequences()
      .find((s) => s.id === id);
    if (sequence) {
      await this.selectSequence(sequence);
    }
  }

  private async handleNavigationSuccess(): Promise<void> {
    const frameImage = this.sequenceService.currentFrameImage();
    if (frameImage) {
      // Update dimensions if changed
      this.stateManagerService.width = frameImage.frame.width;
      this.stateManagerService.height = frameImage.frame.height;

      // Update canvas dimensions
      await this.canvasManagerService.updateCanvasesDimensions();

      // Clear and reload
      this.canvasManagerService.clearAllMasks();
      await this.ioService.load();
      // Reset undo/redo and capture initial state
      this.orchestratorService.resetHistory();
      await this.orchestratorService.captureInitialHistory();
    }

    this.resetFrameIfNeeded();
    this.orchestratorService.requestRedraw();
    await this.updateProgressDisplay();
  }

  private resetFrameIfNeeded() {
    if (this.multiFramesOptions) {
      this.multiFramesOptions.currentFrame =
        this.sequenceService.currentFrameIndex();
    }
  }

  // ==========================================
  // Save
  // ==========================================

  public async save(): Promise<boolean> {
    const success = await this.ioService.save();
    if (success) {
      await this.sequenceService.markCurrentReviewed(true);
    }
    return success;
  }

  /**
   * Mark/unmark every frame of the current sequence as reviewed.
   */
  public async toggleSequenceReviewed(reviewed: boolean): Promise<void> {
    try {
      await this.sequenceService.markCurrentSequenceReviewed(reviewed);
      await this.updateProgressDisplay();
    } catch (error) {
      console.error('Error updating sequence reviewed status:', error);
    }
  }

  get isSequenceReviewed(): boolean {
    return this.sequenceService.isCurrentSequenceReviewed();
  }

  // ==========================================
  // Progress Display
  // ==========================================

  // ==========================================
  // Label Helpers
  // ==========================================

  private cycleToNextLabel() {
    const labels = this.labelService.listSegmentationLabels;
    if (labels.length === 0) return;
    const nextIndex = (this.labelService.getActiveIndex() + 1) % labels.length;
    const next = labels[nextIndex];
    // Mirror a tree click so the selection highlight and instance state stay
    // consistent whichever way the active label was changed.
    this.labelService.activeLabel = next;
    this.labelService.activeSegInstance = {
      label: next,
      instance: -1,
      shade: next.color,
      id: next.id,
    };
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

  // ==========================================
  // Event Handlers
  // ==========================================

  public updateMousePosition(event: MouseEvent) {
    this.mousePosition = { x: event.clientX, y: event.clientY };
  }

  private handleDownloadProgress(info: DownloadProgress) {
    this.displayDownloadDialog = !info.downloaded;
    this.downloadProgress = info.progress;
  }

  // ==========================================
  // Getters for Template
  // ==========================================

  get isMultiframeActive(): boolean {
    return this.sequenceService.frameCount() > 1;
  }

  /**
   * The right settings panel appears whenever there is something to configure
   * (image adjustments, post-processing, bounding boxes, or pen pressure), so
   * the default state with nothing toggled is closed.
   */
  get showSettingsPanel(): boolean {
    return (
      this.editorService.useProcessing ||
      this.editorService.penPostProcess ||
      this.editorService.eraserPostProcess ||
      this.editorService.showBoundingBox ||
      this.editorService.pressureSensitivity
    );
  }

  get totalImages(): number {
    return this.sequenceService.frameCount();
  }

  get activeImageName(): string | null {
    const frame = this.sequenceService.currentFrame();
    return frame?.relative_path ?? null;
  }

  get isLoading(): boolean {
    return this.uiStateService.isLoading || this.sequenceService.loading();
  }

  get loadingStatus(): string {
    return this.uiStateService.loadingStatus;
  }

  get shouldShowLabels(): boolean {
    const config = this.projectService.config();
    return (
      config.segmentation_enabled ||
      config.instance_segmentation_enabled ||
      config.classification_enabled
    );
  }

  /** Left column is shown if there are labels and/or multiple sequences to navigate. */
  get shouldShowLeftPanel(): boolean {
    return this.shouldShowLabels || this.totalSequences > 1;
  }

  get currentFrameIndex(): number {
    return this.sequenceService.currentFrameIndex();
  }

  get totalFrames(): number {
    return this.sequenceService.frameCount();
  }

  get currentSequenceName(): string {
    return this.sequenceService.currentSequence()?.name ?? 'No sequence';
  }

  get currentSequenceIndex(): number {
    const sequences = this.sequenceService.sequences();
    const current = this.sequenceService.currentSequence();
    if (!current) return 0;
    return sequences.findIndex((s) => s.id === current.id);
  }

  get totalSequences(): number {
    return this.sequenceService.sequences().length;
  }

  get globalProgressPercent(): number {
    if (this.globalTotal === 0) return 0;
    return Math.round((this.globalReviewed / this.globalTotal) * 100);
  }

  // ==========================================
  // Update Progress Display (revised)
  // ==========================================

  private async updateProgressDisplay(): Promise<void> {
    const progress = await this.sequenceService.getProgress();
    this.globalReviewed = progress.reviewed;
    this.globalTotal = progress.total;
  }
}
