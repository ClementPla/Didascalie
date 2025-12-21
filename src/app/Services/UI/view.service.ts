// view.service.ts
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { Subject, BehaviorSubject } from 'rxjs';
import { path } from '@tauri-apps/api';

import { ProjectService } from '../ProjectService/project.service';
import { MultiframesService } from '../Project/multiframes.service';
import { IOService } from '../Project/io.service';
import { CanvasManagerService } from '../../Components/pages/editor/drawable-canvas/service/canvas-manager.service';
import { DrawService } from '../../Components/pages/editor/drawable-canvas/service/draw.service';
import { OrchestratorService } from '../../Components/pages/editor/drawable-canvas/service/orchestrator.service';
import { loadImageFile } from '../../Core/save_load';

export interface ProgressInfo {
  currentIndex: number;
  total: number;
  imageName: string;
  percentage: number;
}

export interface LoadingState {
  isLoading: boolean;
  message: string;
}

@Injectable({
  providedIn: 'root',
})
export class ViewService {
  // Loading state
  private loadingSubject = new BehaviorSubject<LoadingState>({ isLoading: false, message: '' });
  public loading$ = this.loadingSubject.asObservable();

  // Legacy getters for backward compatibility
  get isLoading(): boolean {
    return this.loadingSubject.value.isLoading;
  }
  get loadingStatus(): string {
    return this.loadingSubject.value.message;
  }

  // UI settings
  public thumbnailsSize = 128;

  // Events
  public updatedImage = new Subject<void>();
  public progress$ = new Subject<ProgressInfo | null>();

  constructor(
    private router: Router,
    private projectService: ProjectService,
    private multiframeService: MultiframesService,
    private ioService: IOService,
    private canvasManager: CanvasManagerService,
    private drawService: DrawService,
    private orchestrator: OrchestratorService
  ) {}

  // ==========================================
  // Loading State
  // ==========================================

  public setLoading(status: boolean, message: string = '') {
    this.loadingSubject.next({ isLoading: status, message });
  }

  public endLoading() {
    this.loadingSubject.next({ isLoading: false, message: '' });
  }

  // ==========================================
  // Route Navigation
  // ==========================================

  public navigateToGallery() {
    return this.router.navigate(['/gallery']);
  }

  public navigateToEditor() {
    return this.router.navigate(['/editor']);
  }

  public navigateToExport() {
    return this.router.navigate(['/export']);
  }

  public navigateToTestZone() {
    return this.router.navigate(['/testing-zone']);
  }

  // ==========================================
  // Image Navigation
  // ==========================================

  /**
   * Navigate to next or previous image
   */
  public async navigate(direction: 'next' | 'previous'): Promise<boolean> {
    const label = direction === 'next' ? 'next' : 'previous';
    this.setLoading(true, `Loading ${label} image`);

    try {
      await this.save();

      const success = direction === 'next'
        ? await this.goNextInternal()
        : await this.goPreviousInternal();

      if (!success) {
        return false;
      }

      await this.loadCurrentImage();
      return true;
    } catch (error) {
      console.error(`Failed to navigate ${direction}:`, error);
      return false;
    } finally {
      this.endLoading();
    }
  }

  /**
   * Navigate to a specific frame in multiframe mode
   */
  public async navigateToFrame(frameIndex: number): Promise<boolean> {
    try {
      await this.save();

      if (!this.multiframeService.activeGroup) {
        return false;
      }

      const framePath = this.multiframeService.getFrameNameInActiveGroup(frameIndex);
      if (!framePath) {
        console.warn(`Frame ${frameIndex} not found in active group`);
        return false;
      }

      const frameName = this.projectService.extractImagesName([framePath])[0];
      const index = this.projectService.imagesName.indexOf(frameName);

      this.projectService.activeIndex = index;
      this.projectService.activeImage = await this.multiframeService.getFrameInActiveGroup(frameIndex);

      await this.loadCurrentImage(!this.projectService.groupLabels);
      return true;
    } catch (error) {
      console.error('Failed to navigate to frame:', error);
      return false;
    }
  }

  /**
   * Open editor at a specific image index
   */
  public async openEditor(index: number): Promise<void> {
    const wasLoading = this.isLoading;
    if (!wasLoading) {
      this.setLoading(true, 'Opening image');
    }

    try {
      this.projectService.activeIndex = index;

      await this.multiframeService.setActiveGroupFromFilepath(
        this.projectService.imagesName[index]
      );

      const filepath = await path.join(
        this.projectService.inputFolder,
        this.projectService.imagesName[index]
      );

      this.projectService.activeImage = await loadImageFile(filepath);
      await this.navigateToEditor();
      this.updatedImage.next();
    } finally {
      if (!wasLoading) {
        this.endLoading();
      }
    }
  }

  // ==========================================
  // Save & Load
  // ==========================================

  /**
   * Save current annotations
   */
  public async save(): Promise<boolean> {
    try {
      await this.projectService.updateReviewedStatus();
      await this.ioService.save();
      return true;
    } catch (error) {
      console.error('Failed to save:', error);
      return false;
    }
  }

  /**
   * Load the current active image with optional annotation reload
   */
  public async loadCurrentImage(reloadAnnotations: boolean = true): Promise<void> {
    const activeImage = this.projectService.activeImage;
    if (!activeImage) {
      console.warn('No active image to load');
      return;
    }

    try {
      await this.orchestrator.loadImage(activeImage);

      if (reloadAnnotations) {
        this.canvasManager.clearAllCanvas();
        await this.ioService.load();
      }
      this.drawService.refreshAllColors();
      this.emitProgress();
    } catch (error) {
      console.error('Failed to load image:', error);
      throw error;
    }
  }

  // ==========================================
  // Progress
  // ==========================================

  public getProgress(): ProgressInfo | null {
    const { imagesName, activeIndex } = this.projectService;

    if (imagesName.length === 0 || activeIndex === null) {
      return null;
    }

    const total = this.projectService.getTotalImages();
    return {
      currentIndex: activeIndex,
      total,
      imageName: imagesName[activeIndex],
      percentage: (100 * activeIndex) / total
    };
  }

  private emitProgress() {
    this.progress$.next(this.getProgress());
  }

  // ==========================================
  // Navigation Helpers
  // ==========================================

  public get canGoNext(): boolean {
    const { activeIndex, imagesName } = this.projectService;
    return activeIndex !== null && activeIndex < imagesName.length - 1;
  }

  public get canGoPrevious(): boolean {
    const { activeIndex } = this.projectService;
    return activeIndex !== null && activeIndex > 0;
  }

  public get isMultiframeActive(): boolean {
    return !!this.multiframeService.activeGroup;
  }

  // ==========================================
  // Internal Navigation Logic
  // ==========================================

  private async goNextInternal(): Promise<boolean> {
    if (this.projectService.folderAsMultiframes) {
      return this.goNextMultiframe();
    }
    return this.goNextSingle();
  }

  private async goPreviousInternal(): Promise<boolean> {
    if (this.projectService.folderAsMultiframes) {
      return this.goPreviousMultiframe();
    }
    return this.goPreviousSingle();
  }

  private async goNextSingle(): Promise<boolean> {
    const { activeIndex, imagesName } = this.projectService;

    if (activeIndex === null || activeIndex >= imagesName.length - 1) {
      return false;
    }

    await this.openEditor(activeIndex + 1);
    return true;
  }

  private async goPreviousSingle(): Promise<boolean> {
    const { activeIndex } = this.projectService;

    if (activeIndex === null || activeIndex <= 0) {
      return false;
    }

    await this.openEditor(activeIndex - 1);
    return true;
  }

  private async goNextMultiframe(): Promise<boolean> {
    const currentGroup = this.multiframeService.activeGroup;
    const groups = Array.from(this.multiframeService.groupedFrames.keys());
    const currentIndex = groups.indexOf(currentGroup!);

    if (currentIndex === -1 || currentIndex >= groups.length - 1) {
      return false;
    }

    const nextGroup = groups[currentIndex + 1];
    return this.switchToGroup(nextGroup);
  }

  private async goPreviousMultiframe(): Promise<boolean> {
    const currentGroup = this.multiframeService.activeGroup;
    const groups = Array.from(this.multiframeService.groupedFrames.keys());
    const currentIndex = groups.indexOf(currentGroup!);

    if (currentIndex <= 0) {
      return false;
    }

    const previousGroup = groups[currentIndex - 1];
    return this.switchToGroup(previousGroup);
  }

  private async switchToGroup(groupName: string): Promise<boolean> {
    await this.multiframeService.setActiveGroup(groupName);

    const frames = this.multiframeService.groupedFrames.get(groupName);
    if (!frames || frames.length === 0) {
      return false;
    }

    const imageName = frames[0];
    const extractedName = this.projectService.extractImagesName([imageName])[0];
    const index = this.projectService.imagesName.indexOf(extractedName);

    if (index === -1) {
      return false;
    }

    await this.openEditor(index);
    return true;
  }

  // ==========================================
  // Legacy Methods (deprecated, for compatibility)
  // ==========================================

  /** @deprecated Use navigate('next') instead */
  public async goNext(): Promise<boolean> {
    return this.navigate('next');
  }

  /** @deprecated Use navigate('previous') instead */
  public async goPrevious(): Promise<boolean> {
    return this.navigate('previous');
  }
}