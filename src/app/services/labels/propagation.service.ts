import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { api, PropagationReport } from '../../lib/api';
import { IOService } from '../io.service';
import { LabelsService } from './labels.service';
import { NotificationService } from '../notification.service';
import { SequenceService } from '../sequence.service';

export type PropagationScope = 'following' | 'allOthers';

export type PropagationLabelScope = 'all' | 'active';

export interface PropagationRequest {
  scope: PropagationScope;
  labelScope: PropagationLabelScope;
}

/**
 * Copying the current frame's annotations across its sequence. The copy runs
 * in SQLite ({@link api.propagateAnnotations}); this flushes pending edits,
 * resolves the target frames and announces the frames that changed.
 */
@Injectable({ providedIn: 'root' })
export class PropagationService {
  private readonly sequenceService = inject(SequenceService);
  private readonly ioService = inject(IOService);
  private readonly labelsService = inject(LabelsService);
  private readonly notifications = inject(NotificationService);

  /** The ids of frames whose annotations changed without being displayed. */
  readonly propagated$ = new Subject<number[]>();

  /** The settings last confirmed in the dialog, reused by the one-click
   *  toolbar action. */
  readonly settings = signal<PropagationRequest>({
    scope: 'following',
    labelScope: 'all',
  });

  readonly pendingTargetCount = computed(
    () => this.targetFrameIds(this.settings().scope).length,
  );

  /** The frames a request would write to, in sequence order. */
  targetFrameIds(scope: PropagationScope): number[] {
    const frames = this.sequenceService.frames();
    const currentIndex = this.sequenceService.currentFrameIndex();

    return frames
      .filter((_, index) =>
        scope === 'following' ? index > currentIndex : index !== currentIndex,
      )
      .map((frame) => frame.id);
  }

  /** Run a propagation, with the remembered settings by default. Null when
   *  there is nothing to do. */
  async propagate(
    request: PropagationRequest = this.settings(),
  ): Promise<PropagationReport | null> {
    const source = this.sequenceService.currentFrame();
    if (!source) return null;

    const targets = this.targetFrameIds(request.scope);
    if (targets.length === 0) return null;

    // The backend copies what is in the database.
    await this.ioService.saveIfDirty();

    try {
      const report = await api.propagateAnnotations(
        source.id,
        targets,
        this.labelIdsFor(request.labelScope),
        'replace',
      );
      this.propagated$.next(report.applied);
      this.notifyResult(report);
      return report;
    } catch (error) {
      console.error('Failed to propagate annotations:', error);
      this.notifications.error('Propagation failed', String(error));
      return null;
    }
  }

  /** `null`: every label. */
  private labelIdsFor(labelScope: PropagationLabelScope): number[] | null {
    if (labelScope === 'all') return null;
    const active = this.labelsService.activeLabel;
    return active ? [active.id] : null;
  }

  private notifyResult(report: PropagationReport): void {
    const applied = report.applied.length;
    const frames = `${applied} frame${applied === 1 ? '' : 's'}`;

    if (report.skipped.length === 0) {
      this.notifications.success('Labels propagated', `Copied to ${frames}.`);
      return;
    }

    // Skipped frames are almost always of another size.
    const mismatched = report.skipped.filter(
      (s) => s.reason === 'sizeMismatch',
    ).length;
    const detail = mismatched
      ? `Copied to ${frames}. Skipped ${mismatched} of a different size.`
      : `Copied to ${frames}. Skipped ${report.skipped.length}.`;
    this.notifications.warn('Labels partially propagated', detail);
  }
}
