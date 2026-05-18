import { Injectable } from '@angular/core';
import { Subject, Observable } from 'rxjs';

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
 * Dual-system compatible: Maintains orchestrator state while exposing lifecycle hooks.
 */
@Injectable({
  providedIn: 'root',
})
export class NavigationService {
  private readonly progressSource = new Subject<ProgressInfo | null>();
  private readonly frameChangedSource = new Subject<NavigationResult>();

  /** Stream for tracking current position metrics */
  public readonly progress$: Observable<ProgressInfo | null> =
    this.progressSource.asObservable();

  /** Hook for secondary systems (like Image Registration) to react to global navigation changes */
  public readonly frameChanged$: Observable<NavigationResult> =
    this.frameChangedSource.asObservable();

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
  public async navigate(
    direction: NavigationDirection,
  ): Promise<NavigationResult | null> {
    try {
      // 1. Save current state safely
      await this.saveIfNeeded();

      // 2. Perform navigation step
      const success =
        direction === 'next'
          ? await this.sequenceService.nextFrame()
          : await this.sequenceService.prevFrame();

      if (!success) {
        console.warn(`Cannot navigate ${direction}: at boundary layout limit`);
        return null;
      }

      // 3. Load new frame assets
      await this.loadCurrentFrame();

      // 4. Build, dispatch, and return sync data updates
      const result = this.createNavigationResult();
      if (result) {
        await this.emitProgress();
        this.frameChangedSource.next(result);
      }

      return result;
    } catch (error) {
      console.error(`Failed to navigate ${direction}:`, error);
      return null;
    }
  }

  /**
   * Navigate to a specific frame index within current sequence.
   */
  public async navigateToFrame(
    frameIndex: number,
  ): Promise<NavigationResult | null> {
    try {
      await this.saveIfNeeded();
      await this.sequenceService.selectFrame(frameIndex);
      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      if (result) {
        await this.emitProgress();
        this.frameChangedSource.next(result);
      }

      return result;
    } catch (error) {
      console.error('Failed to navigate to frame:', error);
      return null;
    }
  }

  /**
   * Navigate to a specific sequence context.
   */
  public async navigateToSequence(
    sequence: Sequence,
  ): Promise<NavigationResult | null> {
    try {
      await this.saveIfNeeded();
      await this.sequenceService.selectSequence(sequence);
      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      if (result) {
        await this.emitProgress();
        this.frameChangedSource.next(result);
      }

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
      if (!success) return null;

      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      if (result) {
        await this.emitProgress();
        this.frameChangedSource.next(result);
      }

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
      if (!success) return null;

      await this.loadCurrentFrame();

      const result = this.createNavigationResult();
      if (result) {
        await this.emitProgress();
        this.frameChangedSource.next(result);
      }

      return result;
    } catch (error) {
      console.error('Failed to navigate to previous sequence:', error);
      return null;
    }
  }

  // ==========================================
  // Save & Load Operations
  // ==========================================

  /**
   * Save current annotations automatically if marked dirty.
   */
  public async saveIfNeeded(): Promise<boolean> {
    if (!this.sequenceService.currentFrame()) {
      return true;
    }

    try {
      return await this.ioService.saveIfDirty();
    } catch (error) {
      console.error(
        'Failed evaluation during automatic checkpoint save:',
        error,
      );
      return false;
    }
  }

  /**
   * Force save current structural canvas annotations.
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
      console.error('Force save execution failure:', error);
      return false;
    }
  }
  public get currentSequenceId(): number | null {
    return this.sequenceService.currentSequence()?.id ?? null;
  }
  /**
   * Load current frame data safely into canvas orchestrator matrix.
   */
  public async loadCurrentFrame(): Promise<void> {
    const frameImage = this.sequenceService.currentFrameImage();
    if (!frameImage) {
      throw new Error(
        'Navigation failed: No valid frame image reference targets discovered',
      );
    }

    try {
      // Load raw background image layer into native system canvas orchestrator
      await this.orchestrator.loadImage(frameImage.image_base64);

      // Extract existing annotation vectors from previous save systems
      await this.ioService.load();

      // Initialize snapshot timeline state and schedule drawing tick
      await this.orchestrator.captureInitialHistory();
      this.orchestrator.requestRedraw();

      await this.emitProgress();
    } catch (error) {
      console.error(
        'Failed structural synchronization inside orchestrator boundary:',
        error,
      );
      throw error;
    }
  }

  // ==========================================
  // Progress & State Calculations
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
    const progressData = await this.getProgress();
    this.progressSource.next(progressData);
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
    return this.sequenceService.currentFrame()?.relative_path ?? null;
  }

  // ==========================================
  // Internal Helpers
  // ==========================================

  private createNavigationResult(): NavigationResult | null {
    const frame = this.sequenceService.currentFrame();
    const sequence = this.sequenceService.currentSequence();

    if (!frame || !sequence) {
      return null;
    }

    return {
      success: true,
      frameIndex: this.sequenceService.currentFrameIndex(),
      frameId: frame.id,
      sequenceId: sequence.id,
    };
  }
  public async navigateToNextSequenceForRegistration(): Promise<NavigationResult | null> {
  try {
    await this.saveIfNeeded();
    const success = await this.sequenceService.nextSequence();
    if (!success) return null;

    const result = this.createNavigationResult();
    if (result) {
      await this.emitProgress();
      this.frameChangedSource.next(result);
    }
    return result;
  } catch (error) {
    console.error('Failed to navigate to next sequence (registration):', error);
    return null;
  }
}

public async navigateToPrevSequenceForRegistration(): Promise<NavigationResult | null> {
  try {
    await this.saveIfNeeded();
    const success = await this.sequenceService.prevSequence();
    if (!success) return null;

    const result = this.createNavigationResult();
    if (result) {
      await this.emitProgress();
      this.frameChangedSource.next(result);
    }
    return result;
  } catch (error) {
    console.error('Failed to navigate to previous sequence (registration):', error);
    return null;
  }
}
}
