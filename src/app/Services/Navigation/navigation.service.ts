import { Injectable } from '@angular/core';
import { Subject } from 'rxjs';

import { SequenceService } from '../sequence.service';
import { IOService } from '../io.service';
import { OrchestratorService } from '../../Components/pages/editor/drawable-canvas/service/orchestrator.service';
import { Sequence } from '../../lib/api';
export interface ProgressInfo {
  currentIndex: number;
  total: number;
  frameName: string;
  sequenceName: string;
  percentage: number;
  reviewedCount: number;
}

export interface NavigationResult {
  success: boolean;
  frameIndex: number;
  frameId: number;
  sequenceId: number;
}

export type NavigationDirection = 'next' | 'previous';

/**
 * Orchestrates navigation workflows.
 * Coordinates: save → navigate → load → update state.
 */
@Injectable({
  providedIn: 'root',
})
export class NavigationService {
  public progress$ = new Subject<ProgressInfo | null>();

  constructor(
    private sequenceService: SequenceService,
    private ioService: IOService,
    private orchestrator: OrchestratorService,
  ) {}

  // ==========================================
  // Primary Navigation API
  // ==========================================

  /**
   * Navigate to next or previous frame.
   */
  public async navigate(direction: NavigationDirection): Promise<NavigationResult | null> {
    try {
      // 1. Save current state
      await this.saveIfNeeded();

      // 2. Perform navigation
      const success = direction === 'next'
        ? await this.sequenceService.nextFrame()
        : await this.sequenceService.prevFrame();

      if (!success) {
        console.log(`Cannot navigate ${direction}: at boundary`);
        return null;
      }

      // 3. Load new frame
      await this.loadCurrentFrame();

      // 4. Return result
      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error(`Failed to navigate ${direction}:`, error);
      return null;
    }
  }

  /**
   * Navigate to a specific frame index within current sequence.
   */
  public async navigateToFrame(frameIndex: number): Promise<NavigationResult | null> {
    try {
      await this.saveIfNeeded();
      await this.sequenceService.selectFrame(frameIndex);
      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error('Failed to navigate to frame:', error);
      return null;
    }
  }

  /**
   * Navigate to a specific sequence.
   */
  public async navigateToSequence(sequence: Sequence): Promise<NavigationResult | null> {
    try {
      await this.saveIfNeeded();
      await this.sequenceService.selectSequence(sequence);
      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error('Failed to navigate to sequence:', error);
      return null;
    }
  }

  /**
   * Navigate to next sequence.
   */
  public async navigateToNextSequence(): Promise<NavigationResult | null> {
    try {
      await this.saveIfNeeded();

      const success = await this.sequenceService.nextSequence();
      if (!success) {
        return null;
      }

      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error('Failed to navigate to next sequence:', error);
      return null;
    }
  }

  /**
   * Navigate to previous sequence.
   */
  public async navigateToPrevSequence(): Promise<NavigationResult | null> {
    try {
      await this.saveIfNeeded();

      const success = await this.sequenceService.prevSequence();
      if (!success) {
        return null;
      }

      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      this.emitProgress();

      return result;
    } catch (error) {
      console.error('Failed to navigate to previous sequence:', error);
      return null;
    }
  }

  // ==========================================
  // Save & Load
  // ==========================================

  /**
   * Save current annotations if dirty.
   */
  public async saveIfNeeded(): Promise<boolean> {
    if (!this.sequenceService.currentFrame()) {
      return true;
    }

    try {
      return await this.ioService.saveIfDirty();
    } catch (error) {
      console.error('Failed to save:', error);
      return false;
    }
  }

  /**
   * Force save current annotations.
   */
  public async save(): Promise<boolean> {
    if (!this.sequenceService.currentFrame()) {
      return true;
    }

    try {
      const success = await this.ioService.save();
      if (success) {
        await this.sequenceService.markCurrentReviewed(true);
      }
      return success;
    } catch (error) {
      console.error('Failed to save:', error);
      return false;
    }
  }

  /**
   * Load current frame into orchestrator.
   */
  public async loadCurrentFrame(): Promise<void> {
    const frameImage = this.sequenceService.currentFrameImage();
    if (!frameImage) {
      throw new Error('No current frame to load');
    }

    try {
      // Load image into orchestrator
      await this.orchestrator.loadImage(frameImage.image_base64);

      // Load annotations
      await this.ioService.load();

      // Capture history and redraw
      await this.orchestrator.captureInitialHistory();
      this.orchestrator.requestRedraw();

      this.emitProgress();
    } catch (error) {
      console.error('Failed to load frame:', error);
      throw error;
    }
  }

  // ==========================================
  // Progress & State Queries
  // ==========================================

  public async getProgress(): Promise<ProgressInfo | null> {
    const frame = this.sequenceService.currentFrame();
    const sequence = this.sequenceService.currentSequence();

    if (!frame || !sequence) {
      return null;
    }

    const frameIndex = this.sequenceService.currentFrameIndex();
    const totalFrames = this.sequenceService.frameCount();
    const progress = await this.sequenceService.getProgress();

    return {
      currentIndex: frameIndex,
      total: totalFrames,
      frameName: frame.relative_path ?? `Frame ${frame.frame_index}`,
      sequenceName: sequence.name,
      percentage: totalFrames > 0 ? (100 * (frameIndex + 1)) / totalFrames : 0,
      reviewedCount: progress.reviewed,
    };
  }

  private async emitProgress(): Promise<void> {
    this.progress$.next(await this.getProgress());
  }

  public canGoNext(): boolean {
    return !this.sequenceService.isLastFrame();
  }

  public canGoPrevious(): boolean {
    return !this.sequenceService.isFirstFrame();
  }

  public get isMultiframeActive(): boolean {
    return this.sequenceService.frameCount() > 1;
  }

  public get currentSequenceName(): string | null {
    return this.sequenceService.currentSequence()?.name ?? null;
  }

  public get currentFrameName(): string | null {
    const frame = this.sequenceService.currentFrame();
    return frame?.relative_path ?? null;
  }

  // ==========================================
  // Helpers
  // ==========================================

  private createNavigationResult(): NavigationResult {
    const frame = this.sequenceService.currentFrame()!;
    const sequence = this.sequenceService.currentSequence()!;

    return {
      success: true,
      frameIndex: this.sequenceService.currentFrameIndex(),
      frameId: frame.id,
      sequenceId: sequence.id,
    };
  }
}