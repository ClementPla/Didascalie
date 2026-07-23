import { Component, EventEmitter, HostListener, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SliderModule } from 'primeng/slider';
import { PanelModule } from 'primeng/panel';
import { ButtonModule } from 'primeng/button';

import { SequenceService } from '../../../../Services/sequence.service';
import { UIStateService } from '../../../../Services/uistate.service';
import { Sequence } from '../../../../lib/api';

@Component({
  selector: 'app-multi-frames-options',
  imports: [
    CommonModule,
    ToggleSwitchModule,
    FormsModule,
    PanelModule,
    SliderModule,
    ButtonModule,
  ],
  standalone: true,
  templateUrl: './multi-frames-options.component.html',
  styleUrl: './multi-frames-options.component.scss',
})
export class MultiFramesOptionsComponent {
  _isLoaded = false;

  @Output() changeOfFrame: EventEmitter<number> = new EventEmitter<number>();

  /** Asks the host to open the propagation dialog. The dialog cannot live in
   *  this component: it is rendered inside a popover, which is destroyed the
   *  moment it closes — and it closes as soon as the dialog takes focus. */
  @Output() propagateRequested = new EventEmitter<void>();

  constructor(
    public sequenceService: SequenceService,
    private uiStateService: UIStateService,
  ) {}

  // ==========================================
  // Getters for Template
  // ==========================================

  get currentFrame(): number {
    return this.sequenceService.currentFrameIndex();
  }

  set currentFrame(value: number) {
    // This is called by the slider
    if (value !== this.sequenceService.currentFrameIndex()) {
      this.changeOfFrame.emit(value);
    }
  }

  get totalFrames(): number {
    return this.sequenceService.frameCount();
  }

  get maxFrameIndex(): number {
    return Math.max(0, this.totalFrames - 1);
  }

  get hasMultipleFrames(): boolean {
    return this.totalFrames > 1;
  }

  get currentSequence(): Sequence | null {
    return this.sequenceService.currentSequence();
  }

  get sequences(): Sequence[] {
    return this.sequenceService.sequences();
  }

  get progress(): { current: number; total: number } {
    return this.sequenceService.sequenceProgress();
  }

  // ==========================================
  // Actions
  // ==========================================

  multiFrameChanged() {
    if (!this._isLoaded) {
      return;
    }
    this.changeOfFrame.emit(this.currentFrame);
  }

  async selectSequence(sequence: Sequence): Promise<void> {
    this.uiStateService.setLoading(true, 'Loading sequence');
    try {
      await this.sequenceService.selectSequence(sequence);
    } finally {
      this.uiStateService.endLoading();
    }
  }
  async selectSequenceById(sequenceId: number): Promise<void> {
    const sequence = this.sequences.find((s) => s.id === sequenceId);
    if (sequence) {
      await this.selectSequence(sequence);
    }
  }

  // ==========================================
  // Keyboard Navigation
  // ==========================================

  @HostListener('window:keydown.ArrowUp')
  nextFrame() {
    if (!this.hasMultipleFrames) return;

    const nextIndex = this.currentFrame + 1;
    if (nextIndex >= this.totalFrames) {
      this.changeOfFrame.emit(0); // Wrap to first frame
    } else {
      this.changeOfFrame.emit(nextIndex);
    }
  }

  @HostListener('window:keydown.ArrowDown')
  previousFrame() {
    if (!this.hasMultipleFrames) return;

    const prevIndex = this.currentFrame - 1;
    if (prevIndex < 0) {
      this.changeOfFrame.emit(this.totalFrames - 1); // Wrap to last frame
    } else {
      this.changeOfFrame.emit(prevIndex);
    }
  }
}
