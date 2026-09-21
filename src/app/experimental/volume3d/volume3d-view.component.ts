import {
  Component,
  ElementRef,
  NgZone,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputNumberModule } from 'primeng/inputnumber';
import { PopoverModule } from 'primeng/popover';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';

import { MaskVolumeService } from '../../services/mask-volume.service';
import { LabelsService } from '../../services/labels/labels.service';
import { SequenceService } from '../../services/sequence.service';
import { EditorService } from '../../features/editor/services/editor.service';
import { MesherRequest, MesherResponse } from './mesher/mesher.protocol';
import { MeshDetail, Volume3dSettings, Volume3dSettingsService } from './volume3d-settings.service';
import { VolumeScene } from './volume-scene';

/** Brick edge in grid voxels: small enough that an edit remeshes little,
 *  large enough that the brick count (draw calls) stays modest. */
const BRICK = 32;

/**
 * The 3D view beside the editor canvas while 3D mode is on: the label
 * surfaces (meshed in a worker), optional voxel blocks, image planes and a
 * ray-marched rendering of the image.
 *
 * Edits reach it through `MaskVolumeService.edited$`; the changed slices are
 * sent to the mesher, which remeshes only the bricks that changed.
 */
@Component({
  selector: 'app-volume3d-view',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    InputNumberModule,
    PopoverModule,
    SelectModule,
    SliderModule,
    TooltipModule,
  ],
  templateUrl: './volume3d-view.component.html',
  host: { class: 'flex flex-col min-h-0 min-w-0' },
})
export class Volume3dViewComponent implements OnDestroy {
  readonly volume = inject(MaskVolumeService);
  private readonly labels = inject(LabelsService);
  private readonly sequences = inject(SequenceService);
  private readonly editor = inject(EditorService);
  private readonly settingsService = inject(Volume3dSettingsService);
  private readonly zone = inject(NgZone);

  readonly settings = this.settingsService.settings;
  /** Only a detail change remeshes; other settings are display-only. */
  private readonly detail = computed(() => this.settings().detail);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly viewportRef = viewChild.required<ElementRef<HTMLDivElement>>('viewport');

  private scene: VolumeScene | null = null;
  private worker: Worker | null = null;
  private resizeObserver: ResizeObserver | null = null;
  /** Tags worker traffic with the volume it belongs to. */
  private gen = 0;
  private lod = 1;
  private readonly meshed = signal<{ done: number; total: number } | null>(null);
  /** Slices edited since the last flush, as `label:z`. */
  private readonly pendingEdits = new Set<string>();
  private flushScheduled = false;

  readonly detailOptions: { label: string; value: MeshDetail }[] = [
    { label: 'Auto', value: 'auto' },
    { label: 'Full', value: 1 },
    { label: 'Half', value: 2 },
    { label: 'Quarter', value: 4 },
  ];
  readonly modeOptions = [
    { label: 'Maximum intensity', value: 'mip' },
    { label: 'Composite', value: 'composite' },
  ];

  /** One-line state shown over the view while something is loading. */
  readonly statusText = computed(() => {
    switch (this.volume.status()) {
      case 'loading':
        return `Loading volume… ${Math.round(this.volume.progress() * 100)}%`;
      case 'error':
        return this.volume.error() ?? '3D mode is unavailable.';
      case 'ready': {
        const meshed = this.meshed();
        if (meshed && meshed.done < meshed.total) {
          return `Meshing… ${Math.round((meshed.done / meshed.total) * 100)}%`;
        }
        return this.volume.imageReady() ? null : 'Loading image…';
      }
      default:
        return null;
    }
  });

  constructor() {
    afterNextRender(() => this.createScene());

    // A new volume (or a new level of detail): rebuild every mesh.
    effect(() => {
      const status = this.volume.status();
      this.volume.version();
      this.detail();
      untracked(() => {
        if (status === 'ready') this.startMeshing();
        else this.stopMeshing();
      });
    });

    effect(() => {
      const ready = this.volume.imageReady();
      untracked(() => this.scene?.setImage(ready ? this.volume.image : null));
    });

    effect(() => {
      const settings = this.settings();
      untracked(() => this.applySettings(settings));
    });

    effect(() => {
      const z = this.sequences.currentFrameIndex();
      untracked(() => this.scene?.setSlice(z));
    });

    this.volume.edited$
      .pipe(takeUntilDestroyed())
      .subscribe(({ z, label }) => this.queueEdit(label, z));

    // Label colour / visibility changes come through the canvas redraw.
    this.editor.canvasRedraw
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.syncLabels());
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.worker?.terminate();
    this.scene?.dispose();
  }

  // ==========================================
  // Template actions
  // ==========================================

  update(patch: Partial<Volume3dSettings>): void {
    this.settingsService.update(patch);
  }

  toggle(key: 'showSurface' | 'showBlocks' | 'showPlanes' | 'showVolume'): void {
    this.settingsService.update({ [key]: !this.settings()[key] });
  }

  resetCamera(): void {
    this.scene?.resetCamera();
  }

  /** A click (not a drag) on the view jumps the editor to the picked slice. */
  private pointerDownAt: { x: number; y: number } | null = null;
  onPointerDown(event: PointerEvent): void {
    this.pointerDownAt = { x: event.clientX, y: event.clientY };
  }
  onPointerUp(event: PointerEvent): void {
    const down = this.pointerDownAt;
    this.pointerDownAt = null;
    if (!down || event.button !== 0 || !this.scene) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4) return;
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    const hit = this.scene.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
    );
    if (hit) this.volume.sliceSelectRequested$.next(hit.z);
  }

  // ==========================================
  // Scene
  // ==========================================

  private createScene(): void {
    // Rendering and orbiting never need change detection.
    this.zone.runOutsideAngular(() => {
      this.scene = new VolumeScene(this.canvasRef().nativeElement);
      this.resizeObserver = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        this.scene?.resize(width, height);
      });
      this.resizeObserver.observe(this.viewportRef().nativeElement);
    });
    this.applySettings(this.settings());
    this.syncLabels();
    this.scene!.setSlice(this.sequences.currentFrameIndex());
    if (this.volume.status() === 'ready') this.startMeshing();
    if (this.volume.imageReady()) this.scene!.setImage(this.volume.image);
  }

  private applySettings(settings: Volume3dSettings): void {
    const scene = this.scene;
    if (!scene) return;
    const blocksWas = this.blocksOn;
    this.blocksOn = settings.showBlocks;
    scene.setSettings(settings);
    if (blocksWas !== settings.showBlocks) {
      if (!settings.showBlocks) scene.clearBlocks();
      this.post({ type: 'blocks', gen: this.gen, enabled: settings.showBlocks });
    }
  }
  private blocksOn = false;

  private syncLabels(): void {
    this.scene?.setLabels(
      this.labels.listSegmentationLabels.map((l) => ({ color: l.color, visible: l.isVisible })),
    );
  }

  // ==========================================
  // Meshing
  // ==========================================

  private startMeshing(): void {
    const scene = this.scene;
    if (!scene) return;
    const { width: w, height: h, depth: d } = this.volume;
    this.lod = this.settingsService.resolveLod(w, h, d);
    this.gen++;
    this.pendingEdits.clear();
    this.meshed.set({ done: 0, total: 1 });

    scene.setVolume(w, h, d, this.lod);
    this.syncLabels();

    if (!this.worker) {
      // Mesh replies are rendering work: keep them out of change detection.
      this.zone.runOutsideAngular(() => {
        this.worker = new Worker(new URL('./mesher/mesher.worker.ts', import.meta.url), {
          type: 'module',
        });
        this.worker.onmessage = ({ data }: MessageEvent<MesherResponse>) =>
          this.onWorkerMessage(data);
      });
    }
    // The worker gets its own copy: the volume keeps changing under the editor.
    const labels = this.volume.masks.map((m) => m.slice().buffer);
    this.post(
      {
        type: 'init',
        gen: this.gen,
        width: w,
        height: h,
        depth: d,
        lod: this.lod,
        brick: BRICK,
        labels,
        blocks: this.settings().showBlocks,
      },
      labels,
    );
  }

  /** Drop the meshes and the worker (it holds a copy of every label). */
  private stopMeshing(): void {
    this.gen++;
    this.pendingEdits.clear();
    this.meshed.set(null);
    this.worker?.terminate();
    this.worker = null;
    this.scene?.clearMeshes();
  }

  private onWorkerMessage(message: MesherResponse): void {
    if (message.gen !== this.gen) return;
    if (message.type === 'meshes') {
      this.scene?.applyMeshUpdates(message.updates);
    } else {
      // Progress lands in the template, so re-enter Angular — but only when
      // the displayed percentage moves.
      const previous = this.meshed();
      const percent = (m: { done: number; total: number } | null) =>
        m ? Math.floor((m.done / m.total) * 100) : -1;
      const next = { done: message.done, total: message.total };
      if (percent(previous) !== percent(next) || next.done === next.total) {
        this.zone.run(() => this.meshed.set(next));
      }
    }
  }

  /** Coalesce edits per animation frame, then send each changed slab. */
  private queueEdit(label: number, z: number): void {
    if (this.volume.status() !== 'ready') return;
    this.pendingEdits.add(`${label}:${z}`);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      this.flushEdits();
    });
  }

  private flushEdits(): void {
    const { depth, sliceSize, masks } = this.volume;
    const sent = new Set<string>();
    for (const key of this.pendingEdits) {
      const [label, z] = key.split(':').map(Number);
      const mask = masks[label];
      if (!mask) continue;
      // A grid layer covers `lod` slices: send all of them.
      const z0 = Math.floor(z / this.lod) * this.lod;
      const slab = `${label}:${z0}`;
      if (sent.has(slab)) continue;
      sent.add(slab);
      const z1 = Math.min(z0 + this.lod, depth);
      const data = mask.slice(z0 * sliceSize, z1 * sliceSize).buffer;
      this.post({ type: 'slab', gen: this.gen, label, z0, data }, [data]);
    }
    this.pendingEdits.clear();
  }

  private post(message: MesherRequest, transfer: Transferable[] = []): void {
    this.worker?.postMessage(message, transfer);
  }
}
