import { AfterViewInit, Component, NgZone, OnDestroy, OnInit, signal, inject, viewChild } from '@angular/core';
import { CommonModule, NgComponentOutlet } from '@angular/common';
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
import { PropagationDialogComponent } from './multi-frames-options/propagation-dialog/propagation-dialog.component';
import { QuickAccessMenuComponent } from './quick-access-menu/quick-access-menu.component';
import { SequenceNavigatorComponent } from './sequence-navigator/sequence-navigator.component';

// Services
import { EditorService } from './services/editor.service';
import { LabelsService } from '../../services/labels/labels.service';
import { PropagationService } from '../../services/labels/propagation.service';
import { SequenceService } from '../../services/sequence.service';
import { UIStateService } from '../../services/uistate.service';
import { ProjectService } from '../../services/project/project.service';
import { ZoomPanService } from './drawable-canvas/service/zoom-pan.service';
import { CanvasManagerService } from './drawable-canvas/service/canvas-manager.service';
import { KeyboardShortcutService } from './services/keyboard-shortcut.service';
import { StateManagerService } from './drawable-canvas/service/state-manager.service';
import {
  DownloadProgress,
  TauriEventService,
} from '../../services/tauri-event';
import { IOService } from '../../services/io.service';
import { MaskVolumeService } from '../../services/mask-volume.service';
import { NotificationService } from '../../services/notification.service';
import { api } from '../../lib/api';
import { OrchestratorService } from './drawable-canvas/service/orchestrator.service';

// Core
import { Tools } from '../../core/tools';
import { VerticalMenuComponent } from '../../shared/generics/vertical-menu/vertical-menu.component';
import { MenuGroupDirective } from '../../shared/generics/vertical-menu/menu-group.directive';
import { ExperimentalDirective } from '../../experimental/experimental.directive';
import { experimentalEditorPanes } from '../../experimental/registry';

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
    PropagationDialogComponent,
    QuickAccessMenuComponent,
    SequenceNavigatorComponent,
    VerticalMenuComponent,
    MenuGroupDirective,
    ExperimentalDirective,
    NgComponentOutlet,
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
})
export class EditorComponent implements OnInit, AfterViewInit, OnDestroy {
  editorService = inject(EditorService);
  private labelService = inject(LabelsService);
  private uiStateService = inject(UIStateService);
  sequenceService = inject(SequenceService);
  projectService = inject(ProjectService);
  private zoomPanService = inject(ZoomPanService);
  private canvasManagerService = inject(CanvasManagerService);
  private stateManagerService = inject(StateManagerService);
  private keyboardService = inject(KeyboardShortcutService);
  private tauriEvents = inject(TauriEventService);
  private ioService = inject(IOService);
  private orchestratorService = inject(OrchestratorService);
  private ngZone = inject(NgZone);
  propagation = inject(PropagationService);
  private notifications = inject(NotificationService);
  volume = inject(MaskVolumeService);

  readonly canvas = viewChild(DrawableCanvasComponent);
  readonly multiFramesOptions = viewChild(MultiFramesOptionsComponent);
  readonly quickAccessMenu = viewChild<QuickAccessMenuComponent>('quickAccessMenu');

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

  /** Panes experimental features show beside the canvas (e.g. the 3D view). */
  readonly experimentalPanes = experimentalEditorPanes();

  /** Open state of the propagation dialog (opened from the frame-nav popover). */
  readonly propagationVisible = signal(false);
  readonly clearSequenceVisible = signal(false);
  readonly clearingSequence = signal(false);

  /**
   * Erase every annotation in the open sequence, then reload the frame.
   *
   * Unlike clearing a label or a frame this is not undoable — it deletes rows
   * for frames that are not loaded — which is why it is behind a confirmation.
   */
  async clearSequence(): Promise<void> {
    const sequence = this.sequenceService.currentSequence();
    if (!sequence || this.clearingSequence()) return;

    this.clearingSequence.set(true);
    try {
      // Before the delete, not after: autosave fires seconds after the last
      // edit, so a pending write landing afterwards would restore the frame.
      this.ioService.discardPendingSave();
      const frames = await api.clearSequenceAnnotations(sequence.id);
      // Before reloading the canvas, so it reads the cleared frame from the
      // project rather than its stale slice.
      this.volume.reload();
      await this.loadCanvas();
      this.clearSequenceVisible.set(false);
      this.notifications.notify({
        severity: 'success',
        summary: 'Sequence cleared',
        detail: `${frames} annotated frame${frames === 1 ? '' : 's'} erased`,
        life: 4000,
      });
    } catch (error) {
      this.notifications.error('Failed to clear sequence', String(error));
    } finally {
      this.clearingSequence.set(false);
    }
  }

  /** Spells out what the one-click propagate button is about to overwrite. */
  get propagateTooltip(): string {
    const count = this.propagation.pendingTargetCount();
    if (count === 0) return 'No other frames to copy labels to';

    const { scope, labelScope } = this.propagation.settings();
    const frames = `${count} ${scope === 'following' ? 'following' : 'other'} frame${count === 1 ? '' : 's'}`;
    const labels =
      labelScope === 'active'
        ? `"${this.labelService.activeLabel?.label ?? 'active label'}"`
        : 'all labels';
    return `Copy ${labels} to the ${frames}`;
  }

  /**
   * One-click propagation using the settings last confirmed in the dialog.
   * Deliberately has no confirmation step — the tooltip states the exact
   * effect, and the panel dialog remains the way to change the scope.
   */
  public async propagateLabels(): Promise<void> {
    await this.propagation.propagate();
  }

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
    // A volume is large; don't hold it while the editor is closed.
    this.volume.disable();
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

    // Propagation writes other frames straight to the project, behind the
    // volume's back.
    this.propagation.propagated$
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => this.volume.reload());

    this.volume.sliceStepRequested$
      .pipe(takeUntil(this.destroy$))
      .subscribe((step) => this.stepSlice(step));

    this.volume.sliceSelectRequested$
      .pipe(takeUntil(this.destroy$))
      .subscribe((z) => this.goToSlice(z));

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
      nextLabel: () => this.labelService.cycleActive(1),
      previousLabel: () => this.labelService.cycleActive(-1),
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
      nextSequence: () => this.navigateNext(),
      previousSequence: () => this.navigatePrevious(),
      nextFrame: () => this.stepFrame(1),
      previousFrame: () => this.stepFrame(-1),

      'panMode:start': () => this.editorService.activatePanMode(),
      'panMode:end': () => this.editorService.restoreLastTool(),
      'quickMenu:start': () => {
        // Guarded rather than `.required`: the shortcut is bound at the window,
        // so it can fire before this view has initialised.
        const quickAccessMenu = this.quickAccessMenu();
        if (!quickAccessMenu) return;
        quickAccessMenu.position = this.mousePosition;
        quickAccessMenu.toggleOpen();
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
    if (!this.canvas() || !frame) {
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
    this.uiStateService.setLoading(true, 'Loading next sequence');

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
    this.uiStateService.setLoading(true, 'Loading previous sequence');

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

  /**
   * Move `step` frames within the open sequence, wrapping at either end.
   *
   * This used to be a pair of `window:keydown` listeners on the frame-navigation
   * popover's component. The popover renders its content lazily and destroys it
   * on close, so the arrow keys only worked while the popover was open — while
   * the hint inside it claimed otherwise.
   */
  private stepFrame(step: number): void {
    const total = this.sequenceService.frameCount();
    if (total < 2) return;
    const from = this.sequenceService.currentFrameIndex();
    void this.changedOfFrame((((from + step) % total) + total) % total);
  }

  /** Move `step` slices in 3D mode, stopping at the ends (scrolling through a
   *  volume should not wrap around to the other side). */
  private stepSlice(step: number): void {
    const target = this.sequenceService.currentFrameIndex() + step;
    if (target < 0 || target >= this.sequenceService.frameCount()) return;
    void this.changedOfFrame(target);
  }

  /** Latest slice asked for while a navigation was running (see goToSlice). */
  private pendingSlice: number | null = null;

  /**
   * Show slice `z` (3D mode: picked or dragged in the 3D / projection views).
   * Dragging asks for slices faster than they load; rather than dropping the
   * requests that arrive mid-load, keep the latest and go there next, so the
   * editor always ends on the slice the drag ended on.
   */
  private async goToSlice(z: number): Promise<void> {
    if (this.navInFlight) {
      this.pendingSlice = z;
      return;
    }
    this.pendingSlice = null;
    if (z !== this.sequenceService.currentFrameIndex()) {
      await this.changedOfFrame(z); // picks up a pending slice when done
    }
  }

  /** Turn 3D mode on or off (the View menu toggle). */
  public setVolumeMode(on: boolean): void {
    if (on) this.volume.enable();
    else this.volume.disable();
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
      // A slice asked for meanwhile (dragging in the 3D mode views).
      if (this.pendingSlice !== null) void this.goToSlice(this.pendingSlice);
    }
  }

  public async selectSequence(sequence: {
    id: number;
    name: string;
    frameCount: number;
    sortOrder: number;
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
    const sequence = this.sequenceService.sequences().find((s) => s.id === id);
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

      // Reload. `load()` clears the masks itself — except in 3D mode, where
      // they are slices of the volume and must not be cleared.
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
    const multiFramesOptions = this.multiFramesOptions();
    if (multiFramesOptions) {
      multiFramesOptions.currentFrame =
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
   * Mark/unmark the open frame as reviewed. Saving marks it too; this is how
   * you unmark one, or mark it without touching its annotations — which is
   * what picking a subset of a sequence (e.g. slices to train on) needs.
   */
  public async toggleFrameReviewed(reviewed: boolean): Promise<void> {
    try {
      await this.sequenceService.markCurrentReviewed(reviewed);
      await this.updateProgressDisplay();
    } catch (error) {
      console.error('Error updating frame reviewed status:', error);
    }
  }

  get isFrameReviewed(): boolean {
    return this.sequenceService.isCurrentFrameReviewed();
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

  get volumeTooltip(): string {
    if (this.volume.enabled()) {
      return 'Leave 3D mode';
    }
    const reason = this.volume.ineligibility(
      this.sequenceService.frames(),
      this.labelService.listSegmentationLabels.length,
    );
    return reason
      ? `3D mode unavailable: ${reason}`
      : '3D mode: annotate the sequence as a volume (Shift+wheel scrolls slices)';
  }

  /** Short 3D-mode state for the status bar. */
  get volumeStatusText(): string {
    switch (this.volume.status()) {
      case 'loading':
        return `3D · loading ${Math.round(this.volume.progress() * 100)}%`;
      case 'ready':
        return this.volume.imageReady() ? '3D' : '3D · loading image';
      case 'error':
        return '3D · unavailable';
      default:
        return '3D';
    }
  }

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
    return frame?.relativePath ?? null;
  }

  get isLoading(): boolean {
    return this.uiStateService.isLoading() || this.sequenceService.loading();
  }

  get loadingStatus(): string {
    return this.uiStateService.loadingStatus();
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
