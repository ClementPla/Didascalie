// registration-state.service.ts

import { Injectable, computed, signal } from '@angular/core';
import {
  CorrespondencePair,
  FrameRegistration,
  FitSummary,
  Transform2D,
  computeResiduals,
  fitHomography,
  makePair,
  makeRegistration,
  IDENTITY,
  Point2D,
} from './registration.model';

// ==========================================
// Visualization mode
// ==========================================

export type VisualizationMode = 'side-by-side' | 'overlay' | 'checkerboard';

export interface VisualizationOptions {
  mode: VisualizationMode;
  overlayOpacity: number;
  checkerTileSize: number;
  syncPanZoom: boolean;
  showMovingWarped: boolean;
}

const DEFAULT_VIS_OPTIONS: VisualizationOptions = {
  mode: 'side-by-side',
  overlayOpacity: 0.5,
  checkerTileSize: 64,
  syncPanZoom: true,
  showMovingWarped: false,
};

export type PlacementState =
  | { phase: 'idle' }
  | { phase: 'awaiting-moving'; pendingRef: Point2D }
  | { phase: 'awaiting-ref'; pendingMoving: Point2D };

// ==========================================
// Transform type selection
// ==========================================

export type TransformType = 'affine' | 'homography' | 'tps' | 'bspline-grid';

// ==========================================
// Pair color palette
// ==========================================

const PAIR_COLORS = [
  '#e35d6a',
  '#4c8df6',
  '#5fb874',
  '#f0a500',
  '#c084fc',
  '#06b6d4',
  '#f97316',
  '#a3e635',
  '#fb7185',
  '#818cf8',
];

export function colorForIndex(i: number): string {
  return PAIR_COLORS[i % PAIR_COLORS.length];
}

// ==========================================
// Service
// ==========================================

@Injectable({ providedIn: 'root' })
export class RegistrationStateService {
  // ── Frame selection ──────────────────────────────────────────────────────
  private _sequenceId = signal<string | null>(null);
  private _referenceFrameId = signal<string | null>(null);
  private _movingFrameId = signal<string | null>(null);
  private _hoveredPairId = signal<string | null>(null);
  readonly hoveredPairId = this._hoveredPairId.asReadonly();

  readonly sequenceId = this._sequenceId.asReadonly();
  readonly referenceFrameId = this._referenceFrameId.asReadonly();
  readonly movingFrameId = this._movingFrameId.asReadonly();

  readonly framesReady = computed(
    () => this._referenceFrameId() !== null && this._movingFrameId() !== null,
  );

  // ── Registration core ────────────────────────────────────────────────────
  private _registration = signal<FrameRegistration | null>(null);
  readonly registration = this._registration.asReadonly();

  readonly pairs = computed(() => this._registration()?.pairs ?? []);
  readonly transform = computed(
    () => this._registration()?.transform ?? IDENTITY,
  );

  // ── Transform type ───────────────────────────────────────────────────────
  private _transformType = signal<TransformType>('affine');
  readonly transformType = this._transformType.asReadonly();

  // ── Fit summary ──────────────────────────────────────────────────────────
  private _fitSummary = signal<FitSummary | null>(null);
  readonly fitSummary = this._fitSummary.asReadonly();

  readonly pairCount = computed(() => this.pairs().length);

  /**
   * True when enough pairs exist for the selected transform type to be
   * uniquely determined. Affine needs 3; TPS/B-spline need more.
   */
  readonly canFit = computed(() => {
    const n = this.pairCount();
    switch (this._transformType()) {
      case 'affine':
      case 'homography':
        return n >= 4;
      case 'tps':
        return n >= 6;
      case 'bspline-grid':
        return n >= 4;
    }
  });

  // ── Placement state machine ──────────────────────────────────────────────
  private _placement = signal<PlacementState>({ phase: 'idle' });
  readonly placement = this._placement.asReadonly();

  readonly isAwaitingMoving = computed(() => this._placement().phase === 'awaiting-moving');
  readonly isAwaitingReference = computed(() => this._placement().phase === 'awaiting-ref');

// Drop the old isAwaitingMoving-only signal if you had one, or keep both.

  // ── Visualization ────────────────────────────────────────────────────────
  private _vis = signal<VisualizationOptions>({ ...DEFAULT_VIS_OPTIONS });
  readonly vis = this._vis.asReadonly();

  readonly mode = computed(() => this._vis().mode);

  startSession(
    sequenceId: string,
    referenceFrameId?: string,
    movingFrameId?: string,
  ): void {
    this._sequenceId.set(sequenceId);
    this._referenceFrameId.set(referenceFrameId ?? null);
    this._movingFrameId.set(movingFrameId ?? null);
    this._registration.set(null);
    this._fitSummary.set(null);
    this._placement.set({ phase: 'idle' });
    if (referenceFrameId && movingFrameId) {
      this._registration.set(makeRegistration(referenceFrameId, movingFrameId));
    }
  }

  setReferenceFrame(frameId: string): void {
    this._referenceFrameId.set(frameId);
    this.resetRegistration();
  }

  setMovingFrame(frameId: string): void {
    this._movingFrameId.set(frameId);
    this.resetRegistration();
  }
  // In RegistrationStateService
  loadPairs(pairs: CorrespondencePair[]): void {
    const reg = this._registration();
    if (!reg) return;
    const updated: FrameRegistration = { ...reg, pairs: [...pairs] };
    this._registration.set(updated);
    this.refit(updated);
  }
  private resetRegistration(): void {
    const ref = this._referenceFrameId();
    const moving = this._movingFrameId();
    this._placement.set({ phase: 'idle' });
    this._fitSummary.set(null);
    if (ref && moving) {
      this._registration.set(makeRegistration(ref, moving));
    } else {
      this._registration.set(null);
    }
  }

  // ==========================================
  // Placement state machine
  // ==========================================

  /**
   * User clicked on the *reference* pane at native image coordinate `p`.
   * Transitions: idle → awaiting-moving.
   * If already awaiting, replaces the pending ref point.
   */
  placeRefPoint(p: Point2D): void {
    const current = this._placement();

    if (current.phase === 'awaiting-ref') {
      // Completing a moving-first placement.
      this.commitPair(p, current.pendingMoving);
      this._placement.set({ phase: 'idle' });
      return;
    }

    // Starting a ref-first placement (or replacing an in-flight ref-first one).
    this._placement.set({ phase: 'awaiting-moving', pendingRef: { ...p } });
  }
  placeMovingPoint(p: Point2D): void {
    const current = this._placement();

    if (current.phase === 'awaiting-moving') {
      // Completing a ref-first placement.
      this.commitPair(current.pendingRef, p);
      this._placement.set({ phase: 'idle' });
      return;
    }

    // Starting a moving-first placement.
    this._placement.set({ phase: 'awaiting-ref', pendingMoving: { ...p } });
  }

  cancelPlacement(): void {
    this._placement.set({ phase: 'idle' });
  }

  // ==========================================
  // Pair management
  // ==========================================

  private commitPair(ref: Point2D, moving: Point2D): void {
    const reg = this._registration();
    if (!reg) return;
    const newPair = makePair(ref, moving);
    const updated: FrameRegistration = {
      ...reg,
      pairs: [...reg.pairs, newPair],
    };
    this._registration.set(updated);
    this.refit(updated);
  }
  updatePairRef(pairId: string, ref: Point2D): void {
    this.mutatePairs((pairs) =>
      pairs.map((p) => (p.id === pairId ? { ...p, ref: { ...ref } } : p)),
    );
  }

  updatePairMoving(pairId: string, moving: Point2D): void {
    this.mutatePairs((pairs) =>
      pairs.map((p) => (p.id === pairId ? { ...p, moving: { ...moving } } : p)),
    );
  }

  deletePair(pairId: string): void {
    this.mutatePairs((pairs) => pairs.filter((p) => p.id !== pairId));
  }

  clearPairs(): void {
    this.mutatePairs(() => []);
  }

  private mutatePairs(
    fn: (pairs: CorrespondencePair[]) => CorrespondencePair[],
  ): void {
    const reg = this._registration();
    if (!reg) return;
    const updated: FrameRegistration = { ...reg, pairs: fn(reg.pairs) };
    this._registration.set(updated);
    this.refit(updated);
  }

  // ==========================================
  // Solver
  // ==========================================

  private refit(reg: FrameRegistration): void {
    let transform: Transform2D = IDENTITY;

    switch (this._transformType()) {
      case 'affine':
      case 'homography': // accept either name
      case 'tps':
      case 'bspline-grid': {
        // Affine and homography both go through the homography solver now.
        const result = fitHomography(reg.pairs);
        if (result) transform = result;
        break;
      }
    }

    const updated: FrameRegistration = { ...reg, transform };
    this._registration.set(updated);

    if (transform.type !== 'identity') {
      this._fitSummary.set(computeResiduals(transform, reg.pairs));
    } else {
      this._fitSummary.set(null);
    }
  }
  // ==========================================
  // Transform type
  // ==========================================

  setTransformType(t: TransformType): void {
    this._transformType.set(t);
    const reg = this._registration();
    if (reg) this.refit(reg);
  }

  setMode(mode: VisualizationMode): void {
    this._vis.update((v) => ({ ...v, mode }));
  }

  setOverlayOpacity(opacity: number): void {
    this._vis.update((v) => ({
      ...v,
      overlayOpacity: Math.min(1, Math.max(0, opacity)),
    }));
  }

  setCheckerTileSize(size: number): void {
    this._vis.update((v) => ({
      ...v,
      checkerTileSize: Math.max(8, Math.round(size)),
    }));
  }

  setSyncPanZoom(sync: boolean): void {
    this._vis.update((v) => ({ ...v, syncPanZoom: sync }));
  }

  colorForPair(pairId: string): string {
    const idx = this.pairs().findIndex((p) => p.id === pairId);
    return colorForIndex(idx === -1 ? 0 : idx);
  }
  setHoveredPair(id: string | null): void {
    // Equality check: avoid signal writes when the value is unchanged,
    // which would cascade unnecessary redraws.
    if (this._hoveredPairId() !== id) {
      this._hoveredPairId.set(id);
    }
  }

  reset(): void {
    this._sequenceId.set(null);
    this._referenceFrameId.set(null);
    this._movingFrameId.set(null);
    this._registration.set(null);
    this._fitSummary.set(null);
    this._placement.set({ phase: 'idle' });
    this._vis.set({ ...DEFAULT_VIS_OPTIONS });
    this._hoveredPairId.set(null);
  }
  setShowMovingWarped(v: boolean): void {
    this._vis.update((o) => ({
      ...o,
      showMovingWarped: v,
      // Force sync on while warp is on — they must share the same view.
      syncPanZoom: v ? true : o.syncPanZoom,
    }));
  }

  toggleShowMovingWarped(): void {
    this._vis.update((o) => ({ ...o, showMovingWarped: !o.showMovingWarped }));
  }
}
