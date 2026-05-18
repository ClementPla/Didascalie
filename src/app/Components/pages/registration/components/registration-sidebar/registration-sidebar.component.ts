// Components/pages/registration/components/registration-sidebar/registration-sidebar.component.ts

import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { DividerModule } from 'primeng/divider';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';

import {
  RegistrationStateService,
  colorForIndex,
} from '../../registration-state.service';

export interface FrameOption {
  id: string;
  label: string;
}

@Component({
  selector: 'app-registration-sidebar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    DividerModule,
    TagModule,
    TooltipModule,
  ],
  templateUrl: './registration-sidebar.component.html',
  styleUrl: './registration-sidebar.component.scss',
})
export class RegistrationSidebarComponent {
  @Input() frameOptions: FrameOption[] = [];

  @Output() referenceFrameChange = new EventEmitter<string>();
  @Output() movingFrameChange = new EventEmitter<string>();
  @Output() backClicked = new EventEmitter<void>();

  readonly state = inject(RegistrationStateService);
  readonly hoveredPairId = this.state.hoveredPairId;

  // Reactive views.
  readonly pairs = this.state.pairs;
  readonly pairCount = this.state.pairCount;
  readonly fitSummary = this.state.fitSummary;
  readonly canFit = this.state.canFit;
  readonly framesReady = this.state.framesReady;
  readonly isAwaiting = this.state.isAwaitingMoving;

  readonly colorForIndex = colorForIndex;

  // How many more pairs the user needs to reach the affine minimum (3).
  readonly pairsNeeded = computed(() => Math.max(0, 4 - this.pairCount()));

  // ── Frame selector bindings (two-way) ────────────────────────────────────

  get selectedReferenceFrameId(): string {
    return this.state.referenceFrameId() ?? '';
  }
  set selectedReferenceFrameId(v: string) {
    if (v) this.referenceFrameChange.emit(v);
  }

  get selectedMovingFrameId(): string {
    return this.state.movingFrameId() ?? '';
  }
  set selectedMovingFrameId(v: string) {
    if (v) this.movingFrameChange.emit(v);
  }

  // ── Residual helpers (template-facing) ──────────────────────────────────

  residualForPair(pairId: string): number {
    const s = this.fitSummary();
    if (!s) return 0;
    return s.residuals.find((r) => r.pairId === pairId)?.error ?? 0;
  }

  residualColor(pairId: string): string {
    const s = this.fitSummary();
    if (!s || s.maxError === 0) return '#5fb874';
    const ratio = this.residualForPair(pairId) / s.maxError;
    if (ratio < 0.33) return '#5fb874';
    if (ratio < 0.66) return '#f0a500';
    return '#e35d6a';
  }

  setHovered(id: string | null): void {
    this.state.setHoveredPair(id);
  }
}
