import { Injectable, signal, computed, inject } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { ProjectService } from './ProjectService/project.service';
import { Sequence, Frame, FrameImage, api } from '../lib/api';
// ==========================================
// Types
// ==========================================



// ==========================================
// Service
// ==========================================

@Injectable({ providedIn: 'root' })
export class SequenceService {
  private readonly projectService = inject(ProjectService);

  // Private state
  private readonly _sequences = signal<Sequence[]>([]);
  private readonly _currentSequence = signal<Sequence | null>(null);
  private readonly _frames = signal<Frame[]>([]);
  private readonly _currentFrameIndex = signal(0);
  private readonly _currentFrameImage = signal<FrameImage | null>(null);
  private readonly _loading = signal(false);

  // Public readonly signals
  readonly sequences = this._sequences.asReadonly();
  readonly currentSequence = this._currentSequence.asReadonly();
  readonly frames = this._frames.asReadonly();
  readonly currentFrameIndex = this._currentFrameIndex.asReadonly();
  readonly currentFrameImage = this._currentFrameImage.asReadonly();
  readonly loading = this._loading.asReadonly();

  // Computed values
  readonly currentFrame = computed(() => {
    const frames = this._frames();
    const index = this._currentFrameIndex();
    return frames[index] ?? null;
  });

  readonly frameCount = computed(() => this._frames().length);

  readonly sequenceCount = computed(() => this._sequences().length);

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

  readonly isFirstFrame = computed(() => {
    return this._currentFrameIndex() === 0 && this.currentSequenceIndex() === 0;
  });

  readonly isLastFrame = computed(() => {
    const seqIdx = this.currentSequenceIndex();
    const frameIdx = this._currentFrameIndex();
    const sequences = this._sequences();
    const frames = this._frames();
    return seqIdx === sequences.length - 1 && frameIdx === frames.length - 1;
  });

  // ==========================================
  // Loading
  // ==========================================

  /**
   * Load all sequences from the database.
   */
  async loadSequences(): Promise<void> {
    const sequences = await api.listSequences();
    this._sequences.set(sequences);

    // Auto-select first sequence if none selected
    if (sequences.length > 0 && !this._currentSequence()) {
      await this.selectSequence(sequences[0]);
    }
  }

  /**
   * Select a sequence and load its frames.
   */
  async selectSequence(sequence: Sequence): Promise<void> {
    this._currentSequence.set(sequence);
    
    const frames = await api.getSequenceFrames(sequence.id);
    this._frames.set(frames);
    this._currentFrameIndex.set(0);

    // Load first frame image
    if (frames.length > 0) {
      await this.loadCurrentFrameImage();
    }
  }

  /**
   * Select a sequence by index.
   */
  async selectSequenceByIndex(index: number): Promise<void> {
    const sequences = this._sequences();
    if (index >= 0 && index < sequences.length) {
      await this.selectSequence(sequences[index]);
    }
  }

  // ==========================================
  // Frame Navigation
  // ==========================================

  /**
   * Select a frame by index within current sequence.
   */
  async selectFrame(index: number): Promise<void> {
    const frames = this._frames();
    if (index >= 0 && index < frames.length) {
      this._currentFrameIndex.set(index);
      await this.loadCurrentFrameImage();
    }
  }

  /**
   * Go to next frame. Returns true if moved.
   */
  async nextFrame(): Promise<boolean> {
    const index = this._currentFrameIndex();
    const frames = this._frames();

    if (index < frames.length - 1) {
      this._currentFrameIndex.set(index + 1);
      await this.loadCurrentFrameImage();
      return true;
    }

    // Try next sequence
    return this.nextSequence();
  }

  /**
   * Go to previous frame. Returns true if moved.
   */
  async prevFrame(): Promise<boolean> {
    const index = this._currentFrameIndex();

    if (index > 0) {
      this._currentFrameIndex.set(index - 1);
      await this.loadCurrentFrameImage();
      return true;
    }

    // Try previous sequence (go to last frame)
    return this.prevSequence(true);
  }

  /**
   * Go to next sequence. Returns true if moved.
   */
  async nextSequence(): Promise<boolean> {
    const sequences = this._sequences();
    const currentIdx = this.currentSequenceIndex();

    if (currentIdx < sequences.length - 1) {
      await this.selectSequence(sequences[currentIdx + 1]);
      return true;
    }

    return false;
  }

  /**
   * Go to previous sequence. Returns true if moved.
   * @param goToLastFrame If true, go to last frame of previous sequence.
   */
  async prevSequence(goToLastFrame = false): Promise<boolean> {
    const sequences = this._sequences();
    const currentIdx = this.currentSequenceIndex();

    if (currentIdx > 0) {
      await this.selectSequence(sequences[currentIdx - 1]);
      
      if (goToLastFrame) {
        const frames = this._frames();
        this._currentFrameIndex.set(frames.length - 1);
        await this.loadCurrentFrameImage();
      }
      
      return true;
    }

    return false;
  }

  // ==========================================
  // Frame Image Loading
  // ==========================================

  /**
   * Load the image data for the current frame.
   */
  async loadCurrentFrameImage(): Promise<void> {
    const frame = this.currentFrame();
    if (!frame) {
      this._currentFrameImage.set(null);
      return;
    }

    this._loading.set(true);

    try {
      const frameImage = await api.getFrameImage(frame.id);
      this._currentFrameImage.set(frameImage);
    } catch (error) {
      console.error('Failed to load frame image:', error);
      this._currentFrameImage.set(null);
    } finally {
      this._loading.set(false);
    }
  }

  // ==========================================
  // Frame Status
  // ==========================================

  /**
   * Mark current frame as reviewed.
   */
  async markCurrentReviewed(reviewed = true): Promise<void> {
    const frame = this.currentFrame();
    if (!frame) return;

    await api.setFrameReviewed(frame.id, reviewed);

    // Update local state
    this._frames.update(frames =>
      frames.map(f =>
        f.id === frame.id ? { ...f, reviewed } : f
      )
    );
  }

  /**
   * Get progress (reviewed vs total frames).
   */
  async getProgress(): Promise<{ reviewed: number; total: number }> {
    const [reviewed, total] = await api.getProgress();
    return { reviewed, total };
  }

  // ==========================================
  // Utility
  // ==========================================

  /**
   * Get a frame by ID.
   */
  getFrameById(frameId: number): Frame | null {
    return this._frames().find(f => f.id === frameId) ?? null;
  }

  /**
   * Get sequence by ID.
   */
  getSequenceById(sequenceId: number): Sequence | null {
    return this._sequences().find(s => s.id === sequenceId) ?? null;
  }

  /**
   * Check if current frame has been reviewed.
   */
  isCurrentFrameReviewed(): boolean {
    return this.currentFrame()?.reviewed ?? false;
  }

  // ==========================================
  // Reset
  // ==========================================

  reset(): void {
    this._sequences.set([]);
    this._currentSequence.set(null);
    this._frames.set([]);
    this._currentFrameIndex.set(0);
    this._currentFrameImage.set(null);
    this._loading.set(false);
  }
}