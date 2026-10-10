import { Injectable, inject } from '@angular/core';
import { Subject, Observable } from 'rxjs';

import { SequenceService } from '../sequence.service';
import { IOService } from '../io.service';
import { OrchestratorService } from '../../features/editor/drawable-canvas/service/orchestrator.service';
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

/** Navigation between frames and sequences: save, navigate, load. */
@Injectable({
  providedIn: 'root',
})
export class NavigationService {
  private sequenceService = inject(SequenceService);
  private ioService = inject(IOService);
  private orchestrator = inject(OrchestratorService);

  private readonly progressSource = new Subject<ProgressInfo | null>();
  private readonly frameChangedSource = new Subject<NavigationResult>();

  public readonly progress$: Observable<ProgressInfo | null> =
    this.progressSource.asObservable();

  /** For other views (registration) to follow navigation. */
  public readonly frameChanged$: Observable<NavigationResult> =
    this.frameChangedSource.asObservable();

  // ── Primary Navigation API ───────────────────────────────────────────────

  public async navigate(
    direction: NavigationDirection,
  ): Promise<NavigationResult | null> {
    try {
      await this.saveIfNeeded();

      const success =
        direction === 'next'
          ? await this.sequenceService.nextFrame()
          : await this.sequenceService.prevFrame();

      if (!success) {
        console.warn(`Cannot navigate ${direction}: at boundary layout limit`);
        return null;
      }

      await this.loadCurrentFrame();

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

  // ── Save & Load Operations ───────────────────────────────────────────────

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
  public async loadCurrentFrame(): Promise<void> {
    const frameImage = this.sequenceService.currentFrameImage();
    if (!frameImage) {
      throw new Error(
        'Navigation failed: No valid frame image reference targets discovered',
      );
    }

    try {
      // Native dimensions: the image may be a downsampled overview.
      await this.orchestrator.loadImage(
        frameImage.imageBase64,
        frameImage.frame.width,
        frameImage.frame.height,
      );

      await this.ioService.load();

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

  // ── Progress & State Calculations ────────────────────────────────────────

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
      frameName: frame.relativePath ?? `Frame ${frame.frameIndex}`,
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
    return this.sequenceService.currentFrame()?.relativePath ?? null;
  }

  // ── Internal Helpers ─────────────────────────────────────────────────────

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
