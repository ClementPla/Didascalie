import { Component, inject, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SliderModule } from 'primeng/slider';
import { PanelModule } from 'primeng/panel';
import { ButtonModule } from 'primeng/button';

import { SequenceService } from '../../../services/sequence.service';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MultiFramesOptionsComponent {
  sequenceService = inject(SequenceService);

  _isLoaded = false;

  readonly changeOfFrame = output<number>();

  /** Asks the host to open the propagation dialog, which cannot live here: this
   *  component is in a popover, destroyed when the dialog takes focus. */
  readonly propagateRequested = output<void>();

  /** Asks the host to confirm erasing every annotation of this sequence. */
  readonly clearSequenceRequested = output<void>();

  // ── Getters for Template ─────────────────────────────────────────────────

  get currentFrame(): number {
    return this.sequenceService.currentFrameIndex();
  }

  set currentFrame(value: number) {
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

  get progress(): { current: number; total: number } {
    return this.sequenceService.sequenceProgress();
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  multiFrameChanged() {
    if (!this._isLoaded) {
      return;
    }
    this.changeOfFrame.emit(this.currentFrame);
  }
}
