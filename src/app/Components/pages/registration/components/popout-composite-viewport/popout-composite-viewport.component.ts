import { Component, OnInit, OnDestroy, signal, inject, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { listen, emitTo, UnlistenFn } from '@tauri-apps/api/event';
import { CompositeViewportComponent } from '../composite-viewport/composite-viewport.component';
import { ViewportController } from '../../viewport-controller';
import { RegistrationStateService, VisualizationMode } from '../../registration-state.service';
import { Pyramid, PyramidService } from '../../pyramid.service';
import { FrameLoaderService } from '../../frame-loader.service';
import { ButtonModule } from "primeng/button";
import { PopoutToolbarComponent } from "./popout-toolbar/popout-toolbar.component";
interface ModeOption {
  label: string;
  value: VisualizationMode;
  icon: string;
}

@Component({
  selector: 'app-composite-popout',
  standalone: true,
  imports: [CommonModule, CompositeViewportComponent, ButtonModule, PopoutToolbarComponent],
  providers: [RegistrationStateService],
  templateUrl: './popout-composite-viewport.component.html',
})
export class CompositePopoutComponent implements OnInit, OnDestroy {
  readonly popoutRefController = new ViewportController();
  readonly popoutMovingController = new ViewportController();

  readonly refPyramid = signal<Pyramid | null>(null);
  readonly movingPyramid = signal<Pyramid | null>(null);
  readonly movingImageUrl = signal<string | null>(null);
  readonly initialized = signal(false);

  private tauriUnlisteners: UnlistenFn[] = [];
  private readonly state = inject(RegistrationStateService);
  private readonly pyramidSvc = inject(PyramidService);
  private readonly frameLoader = inject(FrameLoaderService);
  @Input() availableModes: VisualizationMode[] = ['side-by-side', 'overlay', 'checkerboard'];
  readonly modeOptions: ModeOption[] = [
    { label: 'Side by side', value: 'side-by-side', icon: 'pi pi-table' },
    { label: 'Overlay', value: 'overlay', icon: 'pi pi-clone' },
    { label: 'Checkerboard', value: 'checkerboard', icon: 'pi pi-th-large' },
  ];

  async ngOnInit() {
    // 1. Establish the main data initializer listener immediately
    const initUnlisten = await listen<any>(
      'init-viewport-data',
      async (event) => {
        console.log('[Popout] received init:', event.payload);
        console.log('[Popout] pairs in payload:', event.payload.pairs?.length);
        const payload = event.payload;

        this.state.startSession(
          payload.sequenceId,
          payload.referenceFrameId,
          payload.movingFrameId,
        );
        this.movingImageUrl.set(payload.movingImageUrl);

        await this.loadPyramidsForCurrentFrames();

        if (payload.pairs) {
          this.state.loadPairs(payload.pairs);
        }

        if (payload.scale && payload.offset) {
          this.applyTransforms(payload.scale, payload.offset);
        }
        this.state.setMode('overlay');
        this.movingImageUrl.set(payload.movingImageUrl);

        this.initialized.set(true);
      },
    );
    this.tauriUnlisteners.push(initUnlisten);
    this.tauriUnlisteners.push(initUnlisten);

    const stateUnlisten = await listen<any>(
      'sync-state-data',
      async (event) => {
        const payload = event.payload;

        // If the frame ids changed, reload pyramids and update state session.
        const currentRefId = this.state.referenceFrameId();
        const currentMovId = this.state.movingFrameId();
        const frameChanged =
          payload.referenceFrameId !== currentRefId ||
          payload.movingFrameId !== currentMovId;

        if (frameChanged) {
          this.state.startSession(
            payload.sequenceId ?? this.state.sequenceId() ?? '',
            payload.referenceFrameId,
            payload.movingFrameId,
          );
          this.movingImageUrl.set(payload.movingImageUrl);
          await this.loadPyramidsForCurrentFrames();
        }

        if (payload.pairs) {
          this.state.loadPairs(payload.pairs);
        }
      },
    );
    this.tauriUnlisteners.push(stateUnlisten);

    // 3. Keep pan/zoom matrices locked with main viewport interactions
    const transformUnlisten = await listen<any>(
      'sync-viewport-transform',
      (event) => {
        const { scale, offset } = event.payload;
        this.applyTransforms(scale, offset);
      },
    );
    this.tauriUnlisteners.push(transformUnlisten);

    // Tell the main window we are ready to receive data payloads
    await emitTo('main', 'popout-ready');
  }
  private async loadPyramidsForCurrentFrames(): Promise<void> {
    const refId = this.state.referenceFrameId();
    const movId = this.state.movingFrameId();
    const loaders: Promise<void>[] = [];

    if (refId) {
      loaders.push(
        this.frameLoader.loadAsImageById(refId).then(async (img) => {
          if (img) this.refPyramid.set(await this.pyramidSvc.getPyramid(img));
        }),
      );
    }
    if (movId) {
      loaders.push(
        this.frameLoader.loadAsImageById(movId).then(async (img) => {
          if (img)
            this.movingPyramid.set(await this.pyramidSvc.getPyramid(img));
        }),
      );
    }
    await Promise.all(loaders);
  }

  private applyTransforms(
    scale: number,
    offset: { x: number; y: number },
  ): void {
    if (typeof scale !== 'number' || !offset) return;
    // ViewportController exposes setTransformExternal for cross-window/cross-pane sync.
    this.popoutRefController.setTransformExternal({ scale, offset });
    this.popoutMovingController.setTransformExternal({ scale, offset });
  }
  ngOnDestroy() {
    this.tauriUnlisteners.forEach((unlistenFn) => unlistenFn());
    this.popoutRefController.destroy();
    this.popoutMovingController.destroy();
  }
}
