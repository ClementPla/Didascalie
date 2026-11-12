import { Injectable, signal, computed, inject } from '@angular/core';
import { Sequence, Frame, FrameImage, PixelInfo, api } from '../lib/api';
import { ProjectScoped } from '../core/project-scoped';
import { WorklistService } from './worklist.service';

@Injectable({ providedIn: 'root' })
export class SequenceService implements ProjectScoped {
  private readonly worklist = inject(WorklistService);
  /** Longest side of the image sent to the editor; larger frames add tiles. */
  static readonly DISPLAY_MAX_DIM = 4096;


  private readonly _sequences = signal<Sequence[]>([]);
  private readonly _currentSequence = signal<Sequence | null>(null);
  private readonly _frames = signal<Frame[]>([]);
  private readonly _currentFrameIndex = signal(0);
  private readonly _currentFrameImage = signal<FrameImage | null>(null);
  /** Set when the current frame is a render of raw pixels (deeper than 8 bits,
   *  or several channels); null for an ordinary 8-bit image. */
  private readonly _currentPixelInfo = signal<PixelInfo | null>(null);
  private readonly _loading = signal(false);

  readonly sequences = this._sequences.asReadonly();
  readonly currentSequence = this._currentSequence.asReadonly();
  readonly frames = this._frames.asReadonly();
  readonly currentFrameIndex = this._currentFrameIndex.asReadonly();
  readonly currentFrameImage = this._currentFrameImage.asReadonly();
  readonly currentPixelInfo = this._currentPixelInfo.asReadonly();
  readonly loading = this._loading.asReadonly();

  readonly currentFrame = computed(() => {
    const frames = this._frames();
    const index = this._currentFrameIndex();
    return frames[index] ?? null;
  });

  readonly frameCount = computed(() => this._frames().length);

  readonly sequenceProgress = computed(() => {
    const index = this._currentFrameIndex();
    const total = this._frames().length;
    return { current: index + 1, total };
  });

  readonly currentSequenceIndex = computed(() => {
    const sequences = this._sequences();
    const current = this._currentSequence();
    if (!current) return -1;
    return sequences.findIndex(s => s.id === current.id);
  });

  readonly isCurrentSequenceReviewed = computed(() => {
    const frames = this._frames();
    return frames.length > 0 && frames.every(f => f.reviewed);
  });

  async loadSequences(): Promise<void> {
    const sequences = await api.listSequences();
    this._sequences.set(sequences);

    if (sequences.length > 0 && !this._currentSequence()) {
      await this.selectSequence(sequences[0]);
    }
  }

  /** Select a sequence and load its frames, opening it on `frameIndex`. */
  async selectSequence(sequence: Sequence, frameIndex = 0): Promise<void> {
    this._currentSequence.set(sequence);
    
    const frames = await api.getSequenceFrames(sequence.id);
    this._frames.set(frames);
    this._currentFrameIndex.set(
      Math.max(0, Math.min(frameIndex, frames.length - 1)),
    );

    if (frames.length > 0) {
      await this.loadCurrentFrameImage();
    }
  }

  // ── Frame Navigation ─────────────────────────────────────────────────────

  async selectFrame(index: number): Promise<void> {
    const frames = this._frames();
    if (index >= 0 && index < frames.length) {
      this._currentFrameIndex.set(index);
      await this.loadCurrentFrameImage();
    }
  }

  /** Returns true if moved. Follows the gallery's worklist when the open
   *  sequence is on it, else the project's order. */
  async nextSequence(): Promise<boolean> {
    return this.stepSequence(1);
  }

  /** Returns true if moved. */
  async prevSequence(): Promise<boolean> {
    return this.stepSequence(-1);
  }

  private async stepSequence(step: 1 | -1): Promise<boolean> {
    const sequences = this._sequences();
    const currentId = this._currentSequence()?.id;

    let target: Sequence | undefined;
    if (this.worklist.indexOf(currentId) >= 0) {
      const id = this.worklist.neighbour(currentId, step);
      target = sequences.find((s) => s.id === id);
    } else {
      target = sequences[this.currentSequenceIndex() + step];
    }
    if (!target) return false;

    await this.selectSequence(target);
    return true;
  }

  // ── Frame Image Loading ──────────────────────────────────────────────────

  async loadCurrentFrameImage(): Promise<void> {
    const frame = this.currentFrame();
    if (!frame) {
      this._currentPixelInfo.set(null);
      this._currentFrameImage.set(null);
      return;
    }

    this._loading.set(true);

    try {
      // Images too large for the browser to decode come as a downsampled
      // overview, native detail from tiles. Deeper than 8 bits, Rust renders
      // them through the sequence's display settings.
      const display = await api.loadFrameDisplay(frame.id, SequenceService.DISPLAY_MAX_DIM);
      // Before the image: loading it reads whether tiles are rendered.
      this._currentPixelInfo.set(display.raw ?? null);
      this._currentFrameImage.set({ frame: display.frame, imageBase64: display.imageBase64 });
    } catch (error) {
      console.error('Failed to load frame image:', error);
      this._currentPixelInfo.set(null);
      this._currentFrameImage.set(null);
    } finally {
      this._loading.set(false);
    }
  }

  // ── Frame Status ─────────────────────────────────────────────────────────

  async markCurrentReviewed(reviewed = true): Promise<void> {
    const frame = this.currentFrame();
    if (!frame) return;

    await api.setFrameReviewed(frame.id, reviewed);

    this._frames.update(frames =>
      frames.map(f =>
        f.id === frame.id ? { ...f, reviewed } : f
      )
    );
  }

  async markCurrentSequenceReviewed(reviewed = true): Promise<void> {
    const frames = this._frames();
    if (frames.length === 0) return;

    const frameIds = frames.map(f => f.id);
    await api.setFramesReviewed(frameIds, reviewed);

    this._frames.update(fs => fs.map(f => ({ ...f, reviewed })));
  }

  /** Frames were marked reviewed or not outside this service (the inspector). */
  noteFramesReviewed(frameIds: readonly number[], reviewed: boolean): void {
    const changed = new Set(frameIds);
    if (!this._frames().some(f => changed.has(f.id))) return;
    this._frames.update(fs =>
      fs.map(f => (changed.has(f.id) ? { ...f, reviewed } : f))
    );
  }

  /** Reviewed and total frames. */
  async getProgress(): Promise<{ reviewed: number; total: number }> {
    const [reviewed, total] = await api.getProgress();
    return { reviewed, total };
  }

  isCurrentFrameReviewed(): boolean {
    return this.currentFrame()?.reviewed ?? false;
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  reset(): void {
    this._sequences.set([]);
    this._currentSequence.set(null);
    this._frames.set([]);
    this._currentFrameIndex.set(0);
    this._currentPixelInfo.set(null);
    this._currentFrameImage.set(null);
    this._loading.set(false);
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this.reset();
  }
}