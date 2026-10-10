import { AfterViewInit, Component, NgZone, OnDestroy, OnInit, signal, inject, viewChild } from '@angular/core';
import { CommonModule, NgComponentOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { ToolbarModule } from 'primeng/toolbar';
import { PanelModule } from 'primeng/panel';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { PopoverModule } from 'primeng/popover';
import { MeterGroupModule } from 'primeng/metergroup';
import { DialogModule } from 'primeng/dialog';
import { ProgressBarModule } from 'primeng/progressbar';

import { DrawableCanvasComponent } from './drawable-canvas/component/drawable-canvas.component';
import { EditorToolbarComponent } from './editor-toolbar/editor-toolbar.component';
import { LabelsComponent } from './labels/labels.component';
import { ToolSettingComponent } from './tool-setting/tool-setting.component';
import { PythonFunctionsComponent } from './python-functions/python-functions.component';
import { PythonSegmentationService } from './python-functions/python-segmentation.service';
import { InferenceClientService } from '../../services/inference-client.service';
import { IS_ANDROID, NARROW_PORTRAIT } from '../../core/platform';
import { LabelBarComponent } from './label-bar/label-bar.component';
import { MultiFramesOptionsComponent } from './multi-frames-options/multi-frames-options.component';
import { PropagationDialogComponent } from './multi-frames-options/propagation-dialog/propagation-dialog.component';
import { QuickAccessMenuComponent } from './quick-access-menu/quick-access-menu.component';
import { SequenceNavigatorComponent } from './sequence-navigator/sequence-navigator.component';

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
import { InspectionService } from '../inspect/inspection.service';
import { NotificationService } from '../../services/notification.service';
import { api } from '../../lib/api';
import { OrchestratorService } from './drawable-canvas/service/orchestrator.service';

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
    PythonFunctionsComponent,
    LabelBarComponent,
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
  private inspection = inject(InspectionService);
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
  /** A tablet held upright: the labels go in a bar above the canvas. */
  readonly narrowPortrait = NARROW_PORTRAIT;
  readonly isAndroid = IS_ANDROID;
  pythonSegmentation = inject(PythonSegmentationService);
  private inferenceClient = inject(InferenceClientService);

  readonly canvas = viewChild(DrawableCanvasComponent);
  readonly multiFramesOptions = viewChild(MultiFramesOptionsComponent);
  readonly quickAccessMenu = viewChild<QuickAccessMenuComponent>('quickAccessMenu');

  public viewPortSize = 800;
  public displayDownloadDialog = false;
  public downloadProgress = 0;

  public labelsCollapsed = false;
  public settingsCollapsed = false;

  private destroy$ = new Subject<void>();
  private mousePosition: { x: number; y: number } = { x: 0, y: 0 };
  private navInFlight = false;
  public globalReviewed = 0;
  public globalTotal = 0;

  readonly experimentalPanes = experimentalEditorPanes();

  readonly propagationVisible = signal(false);
  readonly clearSequenceVisible = signal(false);
  readonly clearingSequence = signal(false);

  /** Erase every annotation in the open sequence, then reload the frame. Not
   *  undoable. */
  async clearSequence(): Promise<void> {
    const sequence = this.sequenceService.currentSequence();
    if (!sequence || this.clearingSequence()) return;

    this.clearingSequence.set(true);
    try {
      // First: a pending autosave landing afterwards would restore the frame.
      this.ioService.discardPendingSave();
      const frames = await api.clearSequenceAnnotations(sequence.id);
      // Before reloading the canvas, which would read its stale slice.
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

  /** One-click propagation, with the settings last confirmed in the dialog. */
  public async propagateLabels(): Promise<void> {
    await this.propagation.propagate();
  }

  async ngOnInit() {
    // Look for the user's Python server while the editor is open. Before the
    // first await, so that ngOnDestroy always balances it.
    if (!IS_ANDROID) this.inferenceClient.startDiscovery();
    await this.tauriEvents.initialize();
    this.initSubscriptions();
    this.ngZone.runOutsideAngular(() => {
      window.addEventListener('mousemove', this.updateMousePosition.bind(this));
    });
  }

  async ngAfterViewInit() {
    if (this.projectService.isOpen()) {
      const frameImage = this.sequenceService.currentFrameImage();

      if (frameImage) {
        await this.initializeCanvas();
      }
    }
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    if (!IS_ANDROID) this.inferenceClient.stopDiscovery();
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

    // Propagation writes other frames straight to the project.
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
      selectRect: () => this.editorService.selectTool(Tools.RECT),
      selectEllipse: () => this.editorService.selectTool(Tools.ELLIPSE),
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
      // Alt is held: aiming at an entry selects it on release; a tap without
      // aiming flips to the previous tool.
      'quickMenu:start': () => {
        // The shortcut is bound at the window and can fire before this view exists.
        this.quickAccessMenu()?.open(this.mousePosition);
      },
      'quickMenu:end': () => {
        const menu = this.quickAccessMenu();
        if (!menu) return;
        if (!menu.close()) this.editorService.swapToPreviousTool();
      },
    };

    const handler = actionHandlers[action];
    if (handler) {
      handler();
    }
  }

  // ── Canvas Initialization & Loading ──────────────────────────────────────

  private async initializeCanvas(): Promise<void> {
    const frameImage = this.sequenceService.currentFrameImage();
    if (!frameImage) {
      console.warn('No frame image available');
      return;
    }

    this.stateManagerService.width = frameImage.frame.width;
    this.stateManagerService.height = frameImage.frame.height;
    await this.canvasManagerService.updateCanvasesDimensions();
    await this.loadCanvas();
  }

  public async loadCanvas(): Promise<void> {
    const frame = this.sequenceService.currentFrame();
    if (!this.canvas() || !frame) {
      console.warn('Canvas or current frame not available');
      return;
    }

    try {
      await this.ioService.load();

      await this.orchestratorService.captureInitialHistory();

      this.orchestratorService.requestRedraw();
      await this.updateProgressDisplay();
    } catch (error) {
      console.error('Error loading canvas:', error);
    }
  }

  // ── Navigation ───────────────────────────────────────────────────────────

  public async navigateNext(): Promise<void> {
    // One navigation at a time: save, clear and load share the canvas.
    if (this.navInFlight) return;
    this.navInFlight = true;
    this.uiStateService.setLoading(true, 'Loading next sequence');

    try {
      await this.ioService.saveIfDirty();

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
      await this.ioService.saveIfDirty();

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

  /** Move `step` frames within the open sequence, wrapping at either end. */
  public stepFrame(step: number): void {
    const total = this.sequenceService.frameCount();
    if (total < 2) return;
    const from = this.sequenceService.currentFrameIndex();
    void this.changedOfFrame((((from + step) % total) + total) % total);
  }

  /** Move `step` slices in 3D mode, without wrapping. */
  private stepSlice(step: number): void {
    const target = this.sequenceService.currentFrameIndex() + step;
    if (target < 0 || target >= this.sequenceService.frameCount()) return;
    void this.changedOfFrame(target);
  }

  /** Latest slice asked for while a navigation was running (see goToSlice). */
  private pendingSlice: number | null = null;

  /** Go to the frame a slider is being dragged over. Frames are asked for
   *  faster than they load; the latest request wins (see `goToSlice`). */
  public scrubToFrame(index: number): void {
    void this.goToSlice(index);
  }

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

  public async inspectSequence(): Promise<void> {
    const sequence = this.sequenceService.currentSequence();
    if (!sequence) return;
    // The inspector reads the project.
    await this.ioService.saveIfDirty();
    await this.inspection.open(
      [sequence.id],
      this.sequenceService.currentFrameIndex(),
    );
  }

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
      this.stateManagerService.width = frameImage.frame.width;
      this.stateManagerService.height = frameImage.frame.height;

      await this.canvasManagerService.updateCanvasesDimensions();

      // `load()` clears the masks, except in 3D mode, where they are slices of the
      // volume.
      await this.ioService.load();
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

  // ── Save ─────────────────────────────────────────────────────────────────

  public async save(): Promise<boolean> {
    const success = await this.ioService.save();
    if (success) {
      await this.sequenceService.markCurrentReviewed(true);
    }
    return success;
  }

  /** Mark or unmark the open frame as reviewed, without touching its
   *  annotations. */
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

  // ── Label Helpers ────────────────────────────────────────────────────────

  private togglePostProcessing() {
    if (this.editorService.isDrawingTool()) {
      this.editorService.penPostProcess = !this.editorService.penPostProcess;
    }
    if (this.editorService.isEraser()) {
      this.editorService.eraserPostProcess =
        !this.editorService.eraserPostProcess;
    }
  }

  // ── Event Handlers ───────────────────────────────────────────────────────

  public updateMousePosition(event: MouseEvent) {
    this.mousePosition = { x: event.clientX, y: event.clientY };
  }

  private handleDownloadProgress(info: DownloadProgress) {
    this.displayDownloadDialog = !info.downloaded;
    this.downloadProgress = info.progress;
  }

  // ── Getters for Template ─────────────────────────────────────────────────

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

  /** The settings panel shows when something to configure is toggled. */
  get showSettingsPanel(): boolean {
    return (
      this.editorService.useProcessing ||
      this.editorService.penPostProcess ||
      this.editorService.eraserPostProcess ||
      this.editorService.showBoundingBox ||
      this.editorService.touchSettingsOpen
    );
  }

  get showRightPanel(): boolean {
    return this.showSettingsPanel || this.pythonSegmentation.available();
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

  private async updateProgressDisplay(): Promise<void> {
    const progress = await this.sequenceService.getProgress();
    this.globalReviewed = progress.reviewed;
    this.globalTotal = progress.total;
  }

  /** Off returns to the previous tool, like releasing Space. */
  setPanTool(on: boolean): void {
    if (on) this.editorService.activatePanMode();
    else this.editorService.restoreLastTool();
  }

}
