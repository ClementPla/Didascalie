// Components/pages/registration/registration.component.ts

import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  HostListener,
  OnDestroy,
  OnInit,
  effect,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ViewportController, SyncGroup } from '../viewport-controller';
import { Pyramid, PyramidService } from '../pyramid.service';
import { RegistrationStateService } from '../registration-state.service';

import { FrameLoaderService } from '../frame-loader.service';
import { SequenceService } from '../../../../Services/sequence.service';
import { NavigationService } from '../../../../Services/Navigation/navigation.service';
import { UIStateService } from '../../../../Services/uistate.service';
import { api, Frame, RegistrationData } from '../../../../lib/api';

import { ViewportPaneComponent } from './viewport-pane/viewport-pane.component';
import { CompositeViewportComponent } from './composite-viewport/composite-viewport.component';
import { RegistrationToolbarComponent } from './registration-toolbar/registration-toolbar.component';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'; // Use '@tauri-apps/api/window' if on Tauri v1
import {
  RegistrationSidebarComponent,
  FrameOption,
} from './registration-sidebar/registration-sidebar.component';
import { emit, emitTo, listen, UnlistenFn } from '@tauri-apps/api/event';

@Component({
  selector: 'app-registration',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    CommonModule,
    ViewportPaneComponent,
    CompositeViewportComponent,
    RegistrationToolbarComponent,
    RegistrationSidebarComponent,
  ],
  templateUrl: './registration.component.html',
  styleUrl: './registration.component.scss',
})
export class RegistrationComponent implements OnInit, AfterViewInit, OnDestroy {
  // ── Owned controllers ─────────────────────────────────────────────────────
  readonly refVP = new ViewportController();
  readonly movingVP = new ViewportController();
  private syncGroup = new SyncGroup();

  // ── Pyramids (signals so child components react on input change) ─────────
  readonly refPyramid = signal<Pyramid | null>(null);
  readonly movingPyramid = signal<Pyramid | null>(null);

  // ── Frame list for the picker ────────────────────────────────────────────
  readonly frameOptions = signal<FrameOption[]>([]);

  // ── Reactive state, aliased for the template ─────────────────────────────
  readonly mode = this.state.mode;
  readonly framesReady = this.state.framesReady;
  readonly movingImageUrl = signal<string | null>(null);
  // ── Services ─────────────────────────────────────────────────────────────
  private readonly destroyRef = inject(DestroyRef);
  private readonly pyramidSvc = inject(PyramidService);
  private readonly frameLoader = inject(FrameLoaderService);
  private readonly seqSvc = inject(SequenceService);
  private readonly navigation = inject(NavigationService);
  private readonly uiState = inject(UIStateService);
  private popoutUnlisten?: UnlistenFn;
  isPoppedOut = signal(false);

  constructor(public state: RegistrationStateService) {
    effect(() => {
      if (!this.isPoppedOut()) return;
      emitTo('composite-view', 'sync-state-data', {
        pairs: this.state.pairs(),
        referenceFrameId: this.state.referenceFrameId(),
        movingFrameId: this.state.movingFrameId(),
        movingImageUrl: this.movingImageUrl(),
      }).catch((err) => console.error('[Tauri Broadcast Error]:', err));
    });
  }

  async ngOnInit(): Promise<void> {
    await this.listenToPopout();
    const seqId = this.navigation.currentSequenceId;
    if (seqId !== null && Number.isFinite(seqId)) {
      await this.loadSequence(seqId);
    }

    // Follow external frame navigation. takeUntilDestroyed prevents
    // accumulating subscriptions across navigations away/back to this route.
    this.navigation.frameChanged$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (String(result.sequenceId) !== this.state.sequenceId()) {
          this.loadSequence(result.sequenceId);
        }
      });
  }

  ngAfterViewInit(): void {
    this.syncGroup.add(this.refVP);
    this.syncGroup.add(this.movingVP);

    let lastSync = this.state.vis().syncPanZoom;
    queueMicrotask(() => {
      // Initial state.
      this.applySyncMode(lastSync);
    });
    let lastScale = 0;
    let lastOffsetX = 0;
    let lastOffsetY = 0;
    const checkSync = () => {
      const s = this.state.vis().syncPanZoom;
      if (s !== lastSync) {
        lastSync = s;
        this.applySyncMode(s);
      }
      if (this.isPoppedOut()) {
        const currentScale = this.refVP.scale();
        const currentOffset = this.refVP.offset();

        if (
          currentScale !== lastScale ||
          currentOffset.x !== lastOffsetX ||
          currentOffset.y !== lastOffsetY
        ) {
          lastScale = currentScale;
          lastOffsetX = currentOffset.x;
          lastOffsetY = currentOffset.y;

          emitTo('composite-view', 'sync-viewport-transform', {
            scale: currentScale,
            offset: currentOffset,
          }).catch((err) => console.error(err));
        }
      }
    };
    let rafId = 0;
    const loop = () => {
      checkSync();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    this.destroyRef.onDestroy(() => cancelAnimationFrame(rafId));
  }

  ngOnDestroy(): void {
    this.isPoppedOut.set(false);
    this.syncGroup.destroy();
    this.refVP.destroy();
    this.movingVP.destroy();
    if (this.popoutUnlisten) {
      this.popoutUnlisten();
    }
  }

  private applySyncMode(synced: boolean): void {
    if (synced) {
      this.syncGroup.resume();
      this.syncGroup.alignTo(this.refVP);
    } else {
      this.syncGroup.pause();
    }
  }

  // ==========================================
  // Sequence + frame loading
  // ==========================================

  private async loadSequence(seqId: number): Promise<void> {
    // Make sure SequenceService has the sequence list cached (used elsewhere).
    if (this.seqSvc.sequences().length === 0) {
      try {
        await this.seqSvc.loadSequences();
      } catch (e) {
        console.error('[Registration] loadSequences failed:', e);
      }
    }

    let frames: Frame[];
    try {
      frames = await api.getSequenceFrames(seqId);
    } catch (e) {
      console.error('[Registration] getSequenceFrames failed:', e);
      return;
    }

    this.frameOptions.set(
      frames.map((f, i) => ({
        id: String(f.id),
        label: f.relative_path ?? `Frame ${i + 1}`,
      })),
    );

    const seqKey = String(seqId);
    if (frames.length >= 2) {
      this.state.startSession(
        seqKey,
        String(frames[0].id),
        String(frames[1].id),
      );
      await this.loadBothFrames();
    } else if (frames.length === 1) {
      this.state.startSession(seqKey, String(frames[0].id));
      await this.loadRefFrame();
    } else {
      this.state.startSession(seqKey);
    }
  }

  async onReferenceFrameChange(frameId: string): Promise<void> {
    this.state.setReferenceFrame(frameId);
    await this.loadRefFrame();
    await this.loadRegistrationForCurrentPair();
  }

  async onMovingFrameChange(frameId: string): Promise<void> {
    this.state.setMovingFrame(frameId);
    await this.loadMovingFrame();
    await this.loadRegistrationForCurrentPair();
  }

  private async loadBothFrames(): Promise<void> {
    this.uiState.setLoading(true, 'Loading registration frames…');
    try {
      await Promise.all([this.loadRefFrame(), this.loadMovingFrame()]);
      await this.loadRegistrationForCurrentPair();
    } finally {
      this.uiState.endLoading();
    }
  }

  private async loadRefFrame(): Promise<void> {
    const frameId = this.state.referenceFrameId();
    if (!frameId) return;
    const img = await this.frameLoader.loadAsImageById(frameId);
    if (!img) return;
    const pyramid = await this.pyramidSvc.getPyramid(img);
    this.refPyramid.set(pyramid);
  }

  private async loadMovingFrame(): Promise<void> {
    const frameId = this.state.movingFrameId();
    if (!frameId) {
      this.movingPyramid.set(null);
      this.movingImageUrl.set(null);
      return;
    }
    const img = await this.frameLoader.loadAsImageById(frameId);
    if (!img) {
      this.movingPyramid.set(null);
      this.movingImageUrl.set(null);
      return;
    }
    const pyramid = await this.pyramidSvc.getPyramid(img);
    this.movingPyramid.set(pyramid);

    this.movingImageUrl.set(img.src);
  }
  // ==========================================
  // Sidebar event handlers
  // ==========================================

  goBack(): void {
    this.uiState.navigateToGallery();
  }

  // ==========================================
  // Window-level cleanup
  // ==========================================

  @HostListener('window:mouseup')
  onWindowMouseUp(): void {
    // Catches the case where the user released the mouse outside the panes.
    // Children's local mouseup handlers cover the in-pane case.
    this.refVP.endDrag();
    this.movingVP.endDrag();
  }
  @HostListener('window:keydown.tab', ['$event'])
  onTabToggle(event: Event): void {
    if (this.mode() !== 'side-by-side') return;

    // Only intercept Tab when the user is "in the viewport" — i.e., the focus
    // is on the body or on a viewport pane / its canvas. Let it fall through
    // to the browser's focus traversal when the user is in a form control.
    const target = event.target as HTMLElement | null;
    const isFormControl =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'SELECT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.tagName === 'BUTTON';
    if (isFormControl) return;

    event.preventDefault();
    this.state.toggleShowMovingWarped();
  }
  async save(): Promise<boolean> {
    const seqIdStr = this.state.sequenceId();
    const refIdStr = this.state.referenceFrameId();
    const movIdStr = this.state.movingFrameId();

    if (!seqIdStr || !refIdStr || !movIdStr) {
      // Nothing to save — no registration session in progress.
      return true;
    }

    const seqId = parseInt(seqIdStr, 10);
    const refId = parseInt(refIdStr, 10);
    const movId = parseInt(movIdStr, 10);

    const pairs = this.state.pairs();
    const transform = this.state.transform();

    const data: RegistrationData = {
      referenceFrameId: refId,
      movingFrameId: movId,
      homography: transform.type === 'homography' ? transform.matrix : null,
      transformType: 'homography',
      pairs: pairs.map((p) => ({
        clientUuid: p.id,
        refX: p.ref.x,
        refY: p.ref.y,
        movingX: p.moving.x,
        movingY: p.moving.y,
      })),
    };

    try {
      await api.saveRegistration(seqId, data);
      return true;
    } catch (e) {
      console.error('[Registration] Save failed:', e);
      return false;
    }
  }
  private async loadRegistrationForCurrentPair(): Promise<void> {
    const refIdStr = this.state.referenceFrameId();
    const movIdStr = this.state.movingFrameId();
    if (!refIdStr || !movIdStr) return;
    const refId = parseInt(refIdStr, 10);
    const movId = parseInt(movIdStr, 10);
    if (Number.isNaN(refId) || Number.isNaN(movId)) return;

    try {
      const data = await api.loadRegistration(refId, movId);
      if (
        this.state.referenceFrameId() !== refIdStr ||
        this.state.movingFrameId() !== movIdStr
      ) {
        return;
      }

      if (!data) return;
      this.state.loadPairs(
        data.pairs.map((p) => ({
          id: p.clientUuid,
          ref: { x: p.refX, y: p.refY },
          moving: { x: p.movingX, y: p.movingY },
        })),
      );
    } catch (e) {
      console.error('[Registration] Load failed:', e);
    }
  }

  async navigateNext(): Promise<void> {
    if (!(await this.save())) return;
    await this.navigation.navigateToNextSequenceForRegistration();
  }

  async navigatePrevious(): Promise<void> {
    if (!(await this.save())) return;
    await this.navigation.navigateToPrevSequenceForRegistration();
  }
  @HostListener('window:keydown.arrowright', ['$event'])
  onArrowRight(event: Event): void {
    if (this.isInFormControl(event)) return;
    (event as KeyboardEvent).preventDefault();
    this.navigateNext();
  }

  @HostListener('window:keydown.arrowleft', ['$event'])
  onArrowLeft(event: Event): void {
    if (this.isInFormControl(event)) return;
    (event as KeyboardEvent).preventDefault();
    this.navigatePrevious();
  }

  @HostListener('window:keydown.control.s', ['$event'])
  onCtrlS(event: Event): void {
    (event as KeyboardEvent).preventDefault();
    this.save();
  }

  @HostListener('window:keydown.escape')
  onEscape(): void {
    this.state.cancelPlacement();
  }

  private isInFormControl(event: KeyboardEvent | Event): boolean {
    const t = event.target as HTMLElement | null;
    return (
      t?.tagName === 'INPUT' ||
      t?.tagName === 'SELECT' ||
      t?.tagName === 'TEXTAREA'
    );
  }

  async listenToPopout() {
    this.popoutUnlisten = await listen('popout-ready', async () => {
      console.log(
        '[Main] About to emit init, pairs count:',
        this.state.pairs().length,
      );
      console.log('[Main] referenceFrameId:', this.state.referenceFrameId());
      console.log('[Main] movingFrameId:', this.state.movingFrameId());
      await emitTo('composite-view', 'init-viewport-data', {
        sequenceId: this.state.sequenceId(),
        referenceFrameId: this.state.referenceFrameId(),
        movingFrameId: this.state.movingFrameId(),
        movingImageUrl: this.movingImageUrl(),
        pairs: this.state.pairs(),
        scale: this.refVP.scale(),
        offset: this.refVP.offset(),
      });
    });
  }
  async openCompositeInNewWindow(): Promise<void> {
    this.isPoppedOut.set(true);
    console.log('[Main] Opening composite viewport in new window');
    const win = new WebviewWindow('composite-view', {
      url: '/composite-registration-viewport-popout',
      title: 'Composite Viewport',
      width: 800,
      height: 600,
    });

    // Listen for the popout being closed.
    win.once('tauri://destroyed', () => {
      this.isPoppedOut.set(false);
    });
  }
}
