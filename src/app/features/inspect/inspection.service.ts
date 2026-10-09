import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ProjectScoped } from '../../core/project-scoped';
import { IOService } from '../../services/io.service';
import { SequenceService } from '../../services/sequence.service';

/** Sequences that can be compared side by side. Each pane keeps its own frame
 *  cache, and past a handful the panes are too small to judge labels on. */
export const MAX_INSPECT_PANES = 6;

/** Width of the left panel, in CSS px. */
export const DEFAULT_SIDEBAR_WIDTH = 272;
export const MIN_SIDEBAR_WIDTH = 200;
const SIDEBAR_WIDTH_KEY = 'didascalie.inspect.sidebarWidth';

/**
 * What the "Inspect sequence" panel shows, and how the rest of the app sends
 * sequences to it.
 *
 * The panel itself is a route component, rebuilt on every visit; this holds
 * what must outlive it: the sequences on screen (so coming back from the editor
 * finds the same comparison) and the player's settings.
 *
 * # The shared sequence
 *
 * The editor, the keypoint pairing panel and the inspector all follow
 * `SequenceService.currentSequence`, which is what makes switching between them
 * stay on the same sequence. The inspector shows several at once, so it is the
 * *focused* pane that plays that role (`shareSequence`).
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

  // Player settings: preferences, kept across sequences and projects.
  readonly fps = signal(10);
  readonly loop = signal(true);
  readonly labelOpacity = signal(0.5);
  /** Outline the labelled regions instead of filling them. */
  readonly edgesOnly = signal(false);
  /** Zooming or panning one pane moves the others the same way. */
  readonly syncViews = signal(true);
  /** A pane keeps its zoom and position when its sequence changes, instead
   *  of fitting the new one. */
  readonly keepView = signal(false);

  /** The sequence list and label toggles on the left are shown. */
  readonly sidebarVisible = signal(true);
  readonly sidebarWidth = signal(readSidebarWidth());

  /**
   * First and last frame to play (0-based, included); null for the sequence's
   * own. Kept from one sequence to the next: looking at the first 30 frames of
   * each video of a project is one setting, not one per video.
   */
  readonly rangeStart = signal<number | null>(null);
  readonly rangeEnd = signal<number | null>(null);

  /** The latest sequence asked to be shared, while one is being applied. */
  private pendingShare: { id: number; frameIndex?: number } | null = null;
  private sharing: Promise<boolean> | null = null;

  /**
   * Show `sequenceIds` in the inspector (at most {@link MAX_INSPECT_PANES}),
   * starting on `startFrame`.
   */
  async open(sequenceIds: number[], startFrame = 0): Promise<boolean> {
    const ids = [...new Set(sequenceIds)].slice(0, MAX_INSPECT_PANES);
    if (ids.length === 0) return false;
    this.sequenceIds.set(ids);
    this.focused.set(0);
    this.startFrame = startFrame;
    this.requested = true;
    return this.router.navigate(['/inspect']);
  }

  /**
   * Whether the sequences on screen were asked for through `open()`, as
   * opposed to being whatever the panel showed last time. Reading it clears it.
   */
  takeRequest(): boolean {
    const requested = this.requested;
    this.requested = false;
    return requested;
  }

  /**
   * Make sequence `id` the app's current one, so the editor and the pairing
   * panel pick it up. With a `frameIndex` it opens on that frame; without, a
   * sequence that is already current keeps the frame it is on. Resolves once
   * done, false when the sequence does not exist.
   *
   * Calls made while one is running collapse to the latest: stepping quickly
   * through sequences should not load each one's frame in turn.
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
      // Cleared in the same turn as the last check above, so a request can
      // never land on a drain that has already decided to stop.
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
      // An edit still waiting for its autosave is saved against whichever
      // frame is current when the timer fires: write it before moving on.
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
      // Not persisted; harmless.
    }
  }

  /** @see ProjectScoped — the panes are project data, the settings are not. */
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
    // Storage unavailable: default width.
  }
  return DEFAULT_SIDEBAR_WIDTH;
}
