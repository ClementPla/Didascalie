import { Injectable, inject } from '@angular/core';
import { Subject, Observable } from 'rxjs';

import { SequenceService } from '../sequence.service';
import { IOService } from '../io.service';

export interface NavigationResult {
  success: boolean;
  frameIndex: number;
  frameId: number;
  sequenceId: number;
}

/** Sequence navigation for the registration view: save, then move. */
@Injectable({
  providedIn: 'root',
})
export class NavigationService {
  private sequenceService = inject(SequenceService);
  private ioService = inject(IOService);

  private readonly frameChangedSource = new Subject<NavigationResult>();

  /** For other views (registration) to follow navigation. */
  public readonly frameChanged$: Observable<NavigationResult> =
    this.frameChangedSource.asObservable();

  public get currentSequenceId(): number | null {
    return this.sequenceService.currentSequence()?.id ?? null;
  }

  public async navigateToNextSequenceForRegistration(): Promise<NavigationResult | null> {
    try {
      if (!(await this.saveIfNeeded())) return null;
      const success = await this.sequenceService.nextSequence();
      if (!success) return null;

      const result = this.createNavigationResult();
      if (result) this.frameChangedSource.next(result);
      return result;
    } catch (error) {
      console.error('Failed to navigate to next sequence (registration):', error);
      return null;
    }
  }

  public async navigateToPrevSequenceForRegistration(): Promise<NavigationResult | null> {
    try {
      if (!(await this.saveIfNeeded())) return null;
      const success = await this.sequenceService.prevSequence();
      if (!success) return null;

      const result = this.createNavigationResult();
      if (result) this.frameChangedSource.next(result);
      return result;
    } catch (error) {
      console.error('Failed to navigate to previous sequence (registration):', error);
      return null;
    }
  }

  private async saveIfNeeded(): Promise<boolean> {
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
}
