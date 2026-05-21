// Components/pages/registration/components/registration-sidebar/registration-sidebar.component.ts
import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { InferenceClientService } from '../../../../../Services/inference-client.service';
import {
  RegistrationStateService,
  colorForIndex,
} from '../../registration-state.service';
import { ButtonModule } from 'primeng/button';
import { DividerModule } from 'primeng/divider';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { InferencePortDialogComponent } from './inference-port-dialog/inference-port-dialog.component';
import { ListboxModule } from 'primeng/listbox';

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
    InferencePortDialogComponent,
    ListboxModule,
  ],
  templateUrl: './registration-sidebar.component.html',
  styleUrl: './registration-sidebar.component.scss',
})
export class RegistrationSidebarComponent {
  public readonly state = inject(RegistrationStateService);
  public readonly canFit = this.state.canFit;
  public readonly collapsed = this.state.sidebarCollapsed;
  public readonly colorForIndex = colorForIndex;
  public readonly fitSummary = this.state.fitSummary;
  public readonly framesReady = this.state.framesReady;
  public readonly hoveredPairId = this.state.hoveredPairId;
  public readonly inference = inject(InferenceClientService);
  public readonly isAwaiting = this.state.isAwaitingMoving;
  public readonly pairCount = this.state.pairCount;



  // Reactive views.
  public readonly pairs = this.state.pairs;

  // How many more pairs the user needs to reach the affine minimum (3).
  public readonly pairsNeeded = computed(() =>
    Math.max(0, 4 - this.pairCount()),
  );
  public readonly prefillTooltip = computed(() => {
    if (!this.inference.isReady())
      return 'Configure connection to your Python server';
    return 'Run your registered function to suggest keypoints';
  });
  public readonly statusError = computed(() => {
    const s = this.inference.status();
    return s.kind === 'error' ? s.message : '';
  });
  public readonly statusReply = computed(() => {
    const s = this.inference.status();
    return s.kind === 'connected' ? s : { registered: [], protocolVersion: 0 };
  });
  public readonly inferenceStatus = this.inference.status;
  public readonly inferenceReady = this.inference.isReady;

  public readonly existingFunctions = computed(() => {
    // Return a list of { name: string, code : string } for each registered function, to populate the dropdown.
    const s = this.inference.status();
    if (s.kind !== 'connected') return [];
    return s.registered
  });

  @Output() public backClicked = new EventEmitter<void>();
  @Input() public frameOptions: FrameOption[] = [];
  public isPrefilling = signal(false);
  @Output() public movingFrameChange = new EventEmitter<string>();
  public portDialogOpen = signal(false);
  @Output() public referenceFrameChange = new EventEmitter<string>();
  public selectedFunctionName = signal<string | null>(null);

  public get selectedMovingFrameId(): string {
    return this.state.movingFrameId() ?? '';
  }

  public set selectedMovingFrameId(v: string) {
    if (v) this.movingFrameChange.emit(v);
  }

  // ── Frame selector bindings (two-way) ────────────────────────────────────
  public get selectedReferenceFrameId(): string {
    return this.state.referenceFrameId() ?? '';
  }

  public set selectedReferenceFrameId(v: string) {
    if (v) this.referenceFrameChange.emit(v);
  }

  public async onConfigureConnection(
    host: string,
    port: number,
  ): Promise<void> {
    try {
      await this.inference.connect(host, port);
      this.portDialogOpen.set(false);
      await this.runPrefill();
    } catch {
      // status is now 'error'; dialog stays open so the user can retry.
    }
  }

  public residualColor(pairId: string): string {
    const s = this.fitSummary();
    if (!s || s.maxError === 0) return '#5fb874';
    const ratio = this.residualForPair(pairId) / s.maxError;
    if (ratio < 0.33) return '#5fb874';
    if (ratio < 0.66) return '#f0a500';
    return '#e35d6a';
  }

  // ── Residual helpers (template-facing) ──────────────────────────────────
  public residualForPair(pairId: string): number {
    const s = this.fitSummary();
    if (!s) return 0;
    return s.residuals.find((r) => r.pairId === pairId)?.error ?? 0;
  }

  public setHovered(id: string | null): void {
    this.state.setHoveredPair(id);
  }

  public toggleCollapsed(): void {
    this.state.toggleSidebar();
  }

  private async runPrefill(): Promise<void> {
    const refId = this.state.referenceFrameId();
    const movId = this.state.movingFrameId();
    const refIdNum = Number(refId);
    const movIdNum = Number(movId);
    if (!Number.isFinite(refIdNum) || !Number.isFinite(movIdNum)) return;
    if (refId == null || movId == null) return;

    const registered = this.inference.registered();
    if (registered.length === 0) return; // ← bail before setting busy
    const fnName = this.selectedFunctionName() ?? registered[0];

    this.isPrefilling.set(true);
    try {
      const newPairs = await this.inference.findKeypoints(
        fnName,
        +refId,
        +movId,
        this.pairs(),
      );
      this.state.applyPrefillPairs(newPairs);
    } catch (e) {
      console.error('[prefill] failed:', e);
    } finally {
      this.isPrefilling.set(false);
    }
  }
  async onFindKeypointsClick(): Promise<void> {
    if (!this.inferenceReady()) {
      this.portDialogOpen.set(true);
      return;
    }
    await this.runPrefill();
  }
}
