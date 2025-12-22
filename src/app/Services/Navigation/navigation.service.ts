// navigation.service.ts
import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';
import { path } from '@tauri-apps/api';

import { ProjectService } from '../ProjectService/project.service';
import { MultiframesService } from '../multiframes.service';
import { IOService } from '../io.service';
import { OrchestratorService } from '../../Components/pages/editor/drawable-canvas/service/orchestrator.service';
import { loadImageFile } from '../../Core/save_load';
import { ProjectFileService } from '../ProjectService';

export interface ProgressInfo {
  currentIndex: number;
  total: number;
  imageName: string;
  percentage: number;
}

export interface NavigationResult {
  success: boolean;
  imageIndex: number;
  imageName: string;
}

export type NavigationDirection = 'next' | 'previous';

/**
 * Orchestrates image and frame navigation workflows.
 * Handles the complete navigation sequence: save → validate → load → update state.
 *
 * Responsibilities:
 * - Coordinate navigation between images/frames
 * - Manage save/load workflows
 * - Track navigation progress
 * - Validate navigation boundaries
 */
@Injectable({
  providedIn: 'root',
})
export class NavigationService {
  // Progress tracking
  public progress$ = new Subject<ProgressInfo | null>();

  constructor(
    private projectService: ProjectService,
    private multiframeService: MultiframesService,
    private ioService: IOService,
    private orchestrator: OrchestratorService,
    private fileService: ProjectFileService
    
  ) {}

  // ==========================================
  // Primary Navigation API
  // ==========================================

  /**
   * Navigate to next or previous image.
   * Handles save, validation, and loading workflow.
   */
  public async navigate(
    direction: NavigationDirection
  ): Promise<NavigationResult | null> {
    try {
      // 1. Save current state
      await this.save();

      // 2. Perform navigation
      const success =
        direction === 'next'
          ? await this.goNextInternal()
          : await this.goPreviousInternal();

      if (!success) {
        console.log(
          `Cannot navigate ${direction}: at boundary or invalid state`
        );
        return null;
      }

      // 3. Return result
      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error(`Failed to navigate ${direction}:`, error);
      return null;
    }
  }

  /**
   * Navigate to a specific image index.
   * Opens and loads the image at the given index.
   */
  public async navigateToIndex(
    index: number
  ): Promise<NavigationResult | null> {
    if (!this.isValidIndex(index)) {
      console.warn(`Invalid image index: ${index}`);
      return null;
    }

    try {
      // Only save if there's currently an active image
      if (
        this.projectService.activeIndex !== null &&
        this.projectService.activeImage
      ) {
        await this.save();
      }

      await this.openEditorInternal(index);

      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error('Failed to navigate to index:', error);
      return null;
    }
  }

  /**
   * Navigate to a specific frame within a multiframe group.
   */
  public async navigateToFrame(
    frameIndex: number
  ): Promise<NavigationResult | null> {
    if (!this.multiframeService.activeGroup) {
      console.warn('No active multiframe group');
      return null;
    }
    console.log(`Navigating to frame ${frameIndex} in group ${this.multiframeService.activeGroup}`);
    try {
      // 1. Save current state
      await this.save();

      // 2. Resolve frame path
      const framePath =
        this.multiframeService.getFramePathInActiveGroup(frameIndex);
      if (!framePath) {
        console.warn(`Frame ${frameIndex} not found in active group`);
        return null;
      }

      // 3. Find image index in project
      const frameName = this.fileService.extractRelativeNames([framePath], this.projectService.inputFolder)[0];
      const index = this.projectService.imagesName.indexOf(frameName);

      if (index === -1) {
        throw new Error(`Frame not found in project: ${frameName}`);
      }

      // 4. Load frame image
      const frameImage = await this.multiframeService.getFrameInActiveGroup(
        frameIndex
      );
      if (!frameImage) {
        throw new Error('Failed to load frame image');
      }

      // 5. Update project state
      this.projectService.activeIndex = index;
      this.projectService.activeImage = frameImage;

      // 6. Load into orchestrator
      await this.loadCurrentImage(!this.projectService.groupLabels);

      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error('Failed to navigate to frame:', error);
      return null;
    }
  }

  // ==========================================
  // Save & Load
  // ==========================================

  /**
   * Save current annotations and update review status.
   */
  public async save(): Promise<boolean> {
    // Don't save if there's no active image or no active index
    if (
      this.projectService.activeIndex === null ||
      !this.projectService.activeImage
    ) {
      console.log('No active image to save, skipping save operation');
      return true;
    }

    try {
      await this.projectService.updateReviewedStatus();
      await this.ioService.save();
      return true;
    } catch (error) {
      console.error('Failed to save:', error);
      // Continue despite save failure
      return false;
    }
  }

  /**
   * Load the current active image into the orchestrator.
   * Optionally reload annotations from disk.
   */
  public async loadCurrentImage(
    reloadAnnotations: boolean = true
  ): Promise<void> {
    const activeImage = this.projectService.activeImage;
    if (!activeImage) {
      throw new Error('No active image to load');
    }

    try {
      // Load image into canvas orchestrator
      await this.orchestrator.loadImage(activeImage);

      // Reload annotations if requested
      if (reloadAnnotations) {
        await this.ioService.load();
      }
      await this.orchestrator.captureInitialHistory();
      this.orchestrator.requestRedraw();

      this.emitProgress();
    } catch (error) {
      console.error('Failed to load image:', error);
      throw error;
    }
  }

  // ==========================================
  // Progress & State Queries
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
      percentage: (100 * activeIndex) / total,
    };
  }

  private emitProgress(): void {
    this.progress$.next(this.getProgress());
  }

  public canGoNext(): boolean {
    const { activeIndex, imagesName } = this.projectService;
    return activeIndex !== null && activeIndex < imagesName.length - 1;
  }

  public canGoPrevious(): boolean {
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

    await this.openEditorInternal(activeIndex + 1);
    return true;
  }

  private async goPreviousSingle(): Promise<boolean> {
    const { activeIndex } = this.projectService;

    if (activeIndex === null || activeIndex <= 0) {
      return false;
    }

    await this.openEditorInternal(activeIndex - 1);
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
    const extractedName = this.fileService.extractRelativeNames([imageName], this.projectService.inputFolder)[0];
    const index = this.projectService.imagesName.indexOf(extractedName);

    if (index === -1) {
      return false;
    }

    await this.openEditorInternal(index);
    return true;
  }

  /**
   * Internal helper to open editor at a specific index.
   * Updates project state and loads image into orchestrator.
   */
  private async openEditorInternal(index: number): Promise<void> {
    this.projectService.activeIndex = index;
    await this.multiframeService.setActiveGroupFromFilepath(
      this.projectService.imagesName[index]
    );

    const filepath = await path.join(
      this.projectService.inputFolder,
      this.projectService.imagesName[index]
    );

    this.projectService.activeImage = await loadImageFile(filepath);
    await this.loadCurrentImage();
  }

  private isValidIndex(index: number): boolean {
    return index >= 0 && index < this.projectService.getTotalImages();
  }

  private createNavigationResult(): NavigationResult {
    const index = this.projectService.activeIndex!;
    return {
      success: true,
      imageIndex: index,
      imageName: this.projectService.imagesName[index],
    };
  }
}
