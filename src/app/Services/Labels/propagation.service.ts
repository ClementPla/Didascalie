import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';

import { api, PropagationReport } from '../../lib/api';
import { IOService } from '../io.service';
import { LabelsService } from './labels.service';
import { NotificationService } from '../notification.service';
import { SequenceService } from '../sequence.service';

/** Which frames of the current sequence receive the current frame's labels. */
export type PropagationScope = 'following' | 'allOthers';

/** Which labels are copied. Anything outside the scope is left untouched. */
export type PropagationLabelScope = 'all' | 'active';

export interface PropagationRequest {
  scope: PropagationScope;
  labelScope: PropagationLabelScope;
}

/**
 * Copy-propagation of the current frame's annotations across its sequence.
 *
 * The actual copy runs in SQLite ({@link api.propagateAnnotations}); this
 * service owns the frontend side of it: flushing pending edits so the database
 * really holds what the user sees, resolving which frames are targeted, and
 * telling the rest of the app that frames it isn't displaying just changed.
 */
@Injectable({ providedIn: 'root' })
export class PropagationService {
  private readonly sequenceService = inject(SequenceService);
  private readonly ioService = inject(IOService);
  private readonly labelsService = inject(LabelsService);
  private readonly notifications = inject(NotificationService);

  /**
   * Emits the frame ids whose annotations changed underneath the UI. Views
   * derived from annotation existence (sequence navigator statuses, gallery
   * thumbnails) refresh from this — the editor itself doesn't need to, since
   * the source frame is never a target.
   */
  readonly propagated$ = new Subject<number[]>();

  /**
   * Last settings the user confirmed in the dialog. The one-click toolbar
   * action reuses them, so what that button does is whatever the user last
   * chose explicitly rather than a hidden constant.
   */
  readonly settings = signal<PropagationRequest>({
    scope: 'following',
    labelScope: 'all',
  });

  /** How many frames the one-click action would write to, right now. */
  readonly pendingTargetCount = computed(
    () => this.targetFrameIds(this.settings().scope).length,
  );

  /**
   * Frames a request would write to, in sequence order. Lets the confirmation
   * dialog state the exact count before anything is committed.
   */
  targetFrameIds(scope: PropagationScope): number[] {
    const frames = this.sequenceService.frames();
    const currentIndex = this.sequenceService.currentFrameIndex();

    return frames
      .filter((_, index) =>
        scope === 'following' ? index > currentIndex : index !== currentIndex,
      )
      .map((frame) => frame.id);
  }

  /**
   * Run a propagation, defaulting to the remembered settings so the toolbar can
   * fire it in one click. Returns null when there is nothing to do (no current
   * frame, or no target frames).
   */
  async propagate(
    request: PropagationRequest = this.settings(),
  ): Promise<PropagationReport | null> {
    const source = this.sequenceService.currentFrame();
    if (!source) return null;

    const targets = this.targetFrameIds(request.scope);
    if (targets.length === 0) return null;

    // The backend copies what is *in the database*. Without this flush the user
    // would propagate the last autosave rather than what is on screen.
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

  /** `null` means "every label" — the backend resolves the full list itself. */
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

    // Skips are almost always frames of a different size, which is a real
    // limitation rather than a transient failure — say so rather than hiding it.
    const mismatched = report.skipped.filter(
      (s) => s.reason === 'sizeMismatch',
    ).length;
    const detail = mismatched
      ? `Copied to ${frames}. Skipped ${mismatched} of a different size.`
      : `Copied to ${frames}. Skipped ${report.skipped.length}.`;
    this.notifications.warn('Labels partially propagated', detail);
  }
}
