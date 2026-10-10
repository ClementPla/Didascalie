import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ProjectScoped } from '../../core/project-scoped';
import { IOService } from '../../services/io.service';
import { SequenceService } from '../../services/sequence.service';

/** Most sequences compared side by side. */
export const MAX_INSPECT_PANES = 6;

/** Width of the left panel, in CSS px. */
export const DEFAULT_SIDEBAR_WIDTH = 272;
export const MIN_SIDEBAR_WIDTH = 200;
const SIDEBAR_WIDTH_KEY = 'didascalie.inspect.sidebarWidth';

/**
 * What the "Inspect sequence" panel shows, kept across visits: the sequences
 * on screen and the player's settings.
 *
 * The editor, the pairing panel and the inspector all follow
 * `SequenceService.currentSequence`. The inspector shows several sequences,
 * so its focused pane plays that role (`shareSequence`).
 */
@Injectable({ providedIn: 'root' })
export class InspectionService implements ProjectScoped {
  private readonly router = inject(Router);
  private readonly sequences = inject(SequenceService);
  private readonly io = inject(IOService);

  /** The sequences on screen, one pane each, in display order. */
  readonly sequenceIds = signal<number[]>([]);
  /** Index in `sequenceIds` of the pane that sequence navigation acts on. */
  readonly focused = signal(0);
  /** Frame to open on; consumed (and reset) by the panel when it starts. */
  startFrame = 0;
  /** `open()` chose the sequences since the panel last started. */
  private requested = false;

  // Player settings, kept across sequences and projects.
  readonly fps = signal(10);
  readonly loop = signal(true);
  readonly labelOpacity = signal(0.5);
  /** Outline the labelled regions instead of filling them. */
  readonly edgesOnly = signal(false);
  /** Zooming or panning one pane moves the others the same way. */
  readonly syncViews = signal(true);
  /** A pane keeps its zoom and position when its sequence changes. */
  readonly keepView = signal(false);

  /** The sequence list and label toggles on the left are shown. */
  readonly sidebarVisible = signal(true);
  readonly sidebarWidth = signal(readSidebarWidth());

  /** First and last frame to play (0-based, included); null for the
   *  sequence's own. Kept from one sequence to the next. */
  readonly rangeStart = signal<number | null>(null);
  readonly rangeEnd = signal<number | null>(null);

  /** The latest sequence asked to be shared, while one is being applied. */
  private pendingShare: { id: number; frameIndex?: number } | null = null;
  private sharing: Promise<boolean> | null = null;

  /** Show `sequenceIds` in the inspector (at most {@link MAX_INSPECT_PANES}). */
  async open(sequenceIds: number[], startFrame = 0): Promise<boolean> {
    const ids = [...new Set(sequenceIds)].slice(0, MAX_INSPECT_PANES);
    if (ids.length === 0) return false;
    this.sequenceIds.set(ids);
    this.focused.set(0);
    this.startFrame = startFrame;
    this.requested = true;
    return this.router.navigate(['/inspect']);
  }

  /** Whether the sequences on screen were asked for through `open()`. Reading
   *  it clears it. */
  takeRequest(): boolean {
    const requested = this.requested;
    this.requested = false;
    return requested;
  }

  /**
   * Make sequence `id` the app's current one, on `frameIndex` when given.
   * Resolves to false when the sequence does not exist. Calls made while one
   * is running collapse to the latest.
   */
  shareSequence(id: number, frameIndex?: number): Promise<boolean> {
    this.pendingShare = { id, frameIndex };
    this.sharing ??= this.drainShares();
    return this.sharing;
  }

  private async drainShares(): Promise<boolean> {
    let shared = false;
    try {
      while (this.pendingShare) {
        const { id, frameIndex } = this.pendingShare;
        this.pendingShare = null;
        shared = await this.applyShare(id, frameIndex);
      }
    } finally {
      this.sharing = null;
    }
    return shared;
  }

  private async applyShare(id: number, frameIndex?: number): Promise<boolean> {
    try {
      if (this.sequences.sequences().length === 0) {
        await this.sequences.loadSequences();
      }
      const sequence = this.sequences.sequences().find((s) => s.id === id);
      if (!sequence) return false;

      const current = this.sequences.currentSequence();
      if (
        current?.id === id &&
        (frameIndex === undefined ||
          this.sequences.currentFrameIndex() === frameIndex)
      ) {
        return true;
      }
      // A pending autosave would be written against the wrong frame.
      await this.io.saveIfDirty();
      await this.sequences.selectSequence(sequence, frameIndex ?? 0);
      return true;
    } catch (error) {
      console.error('Failed to share the inspected sequence:', error);
      return false;
    }
  }

  /** Remember the left panel's width for the next sessions. */
  saveSidebarWidth(): void {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(this.sidebarWidth()));
    } catch {
    }
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.sequenceIds.set([]);
    this.focused.set(0);
    this.startFrame = 0;
    this.requested = false;
    this.pendingShare = null;
    this.rangeStart.set(null);
    this.rangeEnd.set(null);
  }
}

function readSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (stored >= MIN_SIDEBAR_WIDTH) return stored;
  } catch {
  }
  return DEFAULT_SIDEBAR_WIDTH;
}
