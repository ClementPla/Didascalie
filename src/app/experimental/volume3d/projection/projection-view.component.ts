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
import { MenuItem } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { MenuModule } from 'primeng/menu';
import { PopoverModule } from 'primeng/popover';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import { MaskVolumeService } from '../../../services/mask-volume.service';
import { LabelsService } from '../../../services/labels/labels.service';
import { SequenceService } from '../../../services/sequence.service';
import { EditorService } from '../../../features/editor/services/editor.service';
import { VolumeLayoutService } from '../volume-layout.service';
import { Volume3dSettings, Volume3dSettingsService } from '../volume3d-settings.service';
import { CURVE_COLORS } from './curve-overlay.component';
import { MAX_PROJECTED_LABELS } from './projection.constants';
import type { ProjectionRenderer } from './projection-renderer';
import { ProjectionPainterService } from './projection-painter.service';
import { CurveId, ProjectionService } from './projection.service';
import { frameScheduler, observeSize } from '../../../shared/detached-window/detached-window';

/**
 * The projection between the two curves: arc length across, slices down.
 * Read-only; hovering a column highlights its segment on the slice, clicking
 * jumps the editor to the slice under the pointer.
 */
@Component({
  selector: 'app-projection-view',
  standalone: true,
  imports: [FormsModule, ButtonModule, MenuModule, PopoverModule, SelectModule, SliderModule, ToggleSwitchModule, TooltipModule],
  templateUrl: './projection-view.component.html',
  host: { class: 'flex flex-col min-h-0 min-w-0' },
})
export class ProjectionViewComponent implements OnDestroy {
  readonly volume = inject(MaskVolumeService);
  readonly projection = inject(ProjectionService);
  readonly painter = inject(ProjectionPainterService);
  readonly labels = inject(LabelsService);
  private readonly sequences = inject(SequenceService);
  readonly editor = inject(EditorService);
  private readonly settingsService = inject(Volume3dSettingsService);
  private readonly zone = inject(NgZone);

  readonly settings = this.settingsService.settings;
  readonly panelLayout = inject(VolumeLayoutService);
  readonly mode = computed(() => this.panelLayout.modes()['projection']);
  /** Out of the panel a view is always shown whole. */
  readonly expanded = computed(() => this.settings().showProjection || this.mode() !== 'docked');
  readonly colors = CURVE_COLORS;
  /** Per-curve actions, opened from the A / B buttons. */
  readonly curveMenus: Record<CurveId, MenuItem[]> = {
    a: this.curveMenu('a'),
    b: this.curveMenu('b'),
  };
  readonly modeOptions = [
    { label: 'Maximum', value: 'max' },
    { label: 'Mean', value: 'mean' },
    { label: 'Minimum', value: 'min' },
    { label: 'At depth (the painted surface)', value: 'depth' },
  ];

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly viewportRef = viewChild<ElementRef<HTMLDivElement>>('viewport');

  private renderer: ProjectionRenderer | null = null;
  /** Set in ngOnDestroy so a renderer is not built after teardown — the
   *  three.js chunk is fetched asynchronously and can land too late. */
  private destroyed = false;
  private stopObserving: (() => void) | null = null;
  /** Shown in a detached window: overlays attach to the view itself. */
  readonly detached = signal(false);
  private readonly nextFrame = frameScheduler(() => this.canvasRef()?.nativeElement);
  /** Bit `l` set where label `l` is present; mirrors the mask volume. */
  private labelBits: Uint8Array | null = null;
  private readonly dirtySlices = new Set<number>();
  private flushScheduled = false;

  /** The GPU cannot hold this volume as textures. */
  readonly unsupported = signal(false);
  /** CSS size of the output canvas, fitted to the viewport. */
  readonly display = signal({ width: 0, height: 0 });
  private readonly viewport = signal({ width: 0, height: 0 });
  readonly hover = signal<{ column: number; z: number } | null>(null);
  /** Pointer position over the output, in its unzoomed CSS px. */
  readonly pointer = signal<{ x: number; y: number } | null>(null);
  /** The stroke in progress (unzoomed CSS px), drawn until it lands. */
  private readonly trailPoints = signal<{ x: number; y: number }[]>([]);
  readonly trail = computed(() => {
    const points = this.trailPoints();
    return points.length > 0 ? points.map((p) => `${p.x},${p.y}`).join(' ') : null;
  });
  readonly lastStroke = computed(() => this.painter.lastStrokeSlices());

  /** View zoom (1 = fitted) and pan (CSS px) of the output. */
  readonly zoom = signal(1);
  readonly pan = signal({ x: 0, y: 0 });
  readonly panning = signal(false);
  readonly transform = computed(() => {
    const { x, y } = this.pan();
    return `translate(${x}px, ${y}px) scale(${this.zoom()})`;
  });
  private readonly outputRef = viewChild<ElementRef<HTMLDivElement>>('output');
  /** A pan just ended: the click that follows must not jump slices. */
  private suppressClick = false;

  /** Brush outline diameter in CSS px (the output keeps image-pixel aspect). */
  readonly brushDiameter = computed(() => {
    const out = this.projection.columns();
    const width = this.display().width;
    if (!out || !width) return 0;
    return (this.editor.lineWidth * width) / out.count;
  });

  /** Slice under the marker while it is being dragged (ahead of the editor,
   *  which follows as fast as slices load). */
  readonly dragSlice = signal<number | null>(null);
  private draggingMarker = false;

  /** Vertical position of the current slice's marker, in CSS px. */
  readonly sliceMarker = computed(() => {
    const depth = this.volume.depth;
    const height = this.display().height;
    if (!depth || !height) return null;
    const z = this.dragSlice() ?? this.sequences.currentFrameIndex();
    return ((z + 0.5) / depth) * height;
  });

  /** Height of the marker's grab band, in the output's unzoomed px. */
  readonly markerGrab = computed(() => 10 / this.zoom());

  readonly hint = computed(() => {
    const picking = this.projection.picking();
    if (picking) {
      return (
        this.projection.pickMessage() ??
        `Click a label or a vector path on the slice to use it as curve ${picking.toUpperCase()}. Escape cancels.`
      );
    }
    const placing = this.projection.placing();
    if (placing) {
      return `Click on the slice to add points to curve ${placing.toUpperCase()}. Double-click or press Enter to finish.`;
    }
    if (this.volume.status() !== 'ready') return null;
    if (!this.volume.imageReady()) return 'Loading image…';
    if (this.unsupported()) return 'This volume is too large for the GPU.';
    if (!this.projection.ready()) return 'Draw curves A and B on the slice (at least two points each).';
    return null;
  });

  constructor() {
    afterNextRender(() => this.createRenderer());

    effect(() => {
      const ready = this.volume.status() === 'ready' && this.volume.imageReady();
      this.volume.version();
      untracked(() => (ready ? this.loadVolume() : this.unloadVolume()));
    });

    effect(() => {
      const columns = this.projection.columns();
      untracked(() => {
        this.renderer?.setColumns(columns?.ends ?? null, columns?.count ?? 0);
        this.layout();
      });
    });

    effect(() => {
      const settings = this.settings();
      untracked(() => this.applySettings(settings));
    });

    // Keep the output fitted as the pane or the slice spacing changes.
    effect(() => {
      this.viewport();
      this.settings().zSpacing;
      untracked(() => this.layout());
    });

    // A dropped marker hands over once the editor shows its slice.
    effect(() => {
      const z = this.sequences.currentFrameIndex();
      untracked(() => {
        if (!this.draggingMarker && this.dragSlice() === z) this.dragSlice.set(null);
      });
    });

    this.volume.edited$.pipe(takeUntilDestroyed()).subscribe(({ z }) => this.queueSlice(z));
    this.editor.canvasRedraw.pipe(takeUntilDestroyed()).subscribe(() => this.syncLabels());
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.painter.setEditing(false);
    this.stopObserving?.();
    this.renderer?.dispose();
    this.projection.hoverColumn.set(null);
  }

  // ==========================================
  // Template actions
  // ==========================================

  /** The A / B button: finishes an ongoing action on that curve, otherwise
   *  opens its menu. */
  onCurveButton(id: CurveId, event: Event, menu: { toggle(e: Event): void }): void {
    if (this.projection.placing() === id) this.projection.finishPlacing();
    else if (this.projection.picking() === id) this.projection.cancelPicking();
    else menu.toggle(event);
  }

  private curveMenu(id: CurveId): MenuItem[] {
    const name = id.toUpperCase();
    return [
      {
        label: `Draw ${name} on the slice`,
        icon: 'pi pi-pencil',
        command: () => this.projection.startPlacing(id),
      },
      {
        label: `${name} from a label or path`,
        icon: 'pi pi-share-alt',
        command: () => this.projection.startPicking(id),
      },
      {
        label: `Reverse ${name}`,
        icon: 'pi pi-arrow-right-arrow-left',
        command: () => this.projection.reverse(id),
      },
      {
        label: `Clear ${name}`,
        icon: 'pi pi-times',
        command: () => this.projection.clearCurve(id),
      },
    ];
  }

  update(patch: Partial<Volume3dSettings>): void {
    this.settingsService.update(patch);
  }

  /** Colour of the brush: the active label's (the eraser is drawn white). */
  brushColor(): string {
    return this.labels.activeLabel?.color ?? '#ffffff';
  }

  activeLabelName(): string {
    return this.labels.activeLabel?.label ?? '';
  }

  onPointerDown(event: PointerEvent): void {
    if (!this.painter.editing() || event.button !== 0) return;
    const at = this.locateExact(event);
    if (!at) return;
    event.preventDefault();
    event.stopPropagation(); // not a pan
    (event.target as Element).setPointerCapture(event.pointerId);
    this.trailPoints.set([this.localPoint(event)]);
    this.painter.begin(at.col, at.z);
  }

  onPointerMove(event: PointerEvent): void {
    const at = this.locate(event);
    this.hover.set(at);
    this.projection.hoverColumn.set(at?.column ?? null);
    const local = this.localPoint(event);
    this.pointer.set(local);
    if (this.painter.painting) {
      this.trailPoints.update((points) => [...points, local]);
      const exact = this.locateExact(event, false);
      if (exact) this.painter.moveTo(exact.col, exact.z);
    }
  }

  onPointerUp(): void {
    this.painter.end();
    // Keep the trail one more frame, until the labels it wrote are drawn.
    this.nextFrame(() => this.nextFrame(() => this.trailPoints.set([])));
  }

  /**
   * Wheel zooms around the pointer; Ctrl+wheel resizes the brush (as on the
   * slice) and Alt+wheel moves the depth strokes are written at.
   */
  onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.altKey) {
      // Finer with Shift, for a thin structure between close curves.
      const step = event.shiftKey ? 0.002 : 0.01;
      const depth = this.settings().projectionDepth + (event.deltaY > 0 ? -step : step);
      this.update({ projectionDepth: Math.min(1, Math.max(0, Number(depth.toFixed(3)))) });
      return;
    }
    if (event.ctrlKey && this.painter.editing()) {
      const step = Math.max(1, Math.round(this.editor.lineWidth * 0.1));
      this.editor.lineWidth = Math.max(1, this.editor.lineWidth + (event.deltaY > 0 ? -step : step));
      return;
    }
    const output = this.outputRef()?.nativeElement;
    if (!output) return;
    const rect = output.getBoundingClientRect();
    const old = this.zoom();
    const next = Math.min(64, Math.max(1, old * Math.exp(-event.deltaY * 0.0015)));
    if (next === old) return;
    // Keep the point under the cursor fixed.
    const lx = (event.clientX - rect.left) / old;
    const ly = (event.clientY - rect.top) / old;
    const { x, y } = this.pan();
    this.zoom.set(next);
    this.pan.set(next === 1 ? { x: 0, y: 0 } : { x: x + lx * (old - next), y: y + ly * (old - next) });
  }

  /** Middle- or right-drag pans; left-drag too when not painting. */
  onViewportPointerDown(event: PointerEvent): void {
    const left = event.button === 0;
    if (!(event.button === 1 || event.button === 2 || (left && !this.painter.editing()))) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    const from = this.pan();
    let moved = false;
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < 4) return;
      moved = true;
      this.panning.set(true);
      this.pan.set({ x: from.x + dx, y: from.y + dy });
    };
    const up = () => {
      win.removeEventListener('pointermove', move);
      win.removeEventListener('pointerup', up);
      this.panning.set(false);
      this.suppressClick = moved;
    };
    // The window the pointer is in: the view may be detached.
    const win = event.view ?? window;
    win.addEventListener('pointermove', move);
    win.addEventListener('pointerup', up);
  }

  resetView(): void {
    this.zoom.set(1);
    this.pan.set({ x: 0, y: 0 });
  }

  // ==========================================
  // Dragging the current-slice marker
  // ==========================================

  startSliceDrag(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation(); // neither a pan nor a stroke
    (event.target as Element).setPointerCapture(event.pointerId);
    this.draggingMarker = true;
    this.dragSliceTo(event);
  }

  onSliceDrag(event: PointerEvent): void {
    if (!this.draggingMarker) return;
    this.dragSliceTo(event);
  }

  /** The marker stays where it was dropped until the editor gets there. */
  endSliceDrag(): void {
    this.draggingMarker = false;
    if (this.dragSlice() === this.sequences.currentFrameIndex()) this.dragSlice.set(null);
  }

  private dragSliceTo(event: PointerEvent): void {
    const depth = this.volume.depth;
    const height = this.display().height;
    if (!depth || !height) return;
    const z = Math.min(depth - 1, Math.max(0, Math.floor((this.localPoint(event).y / height) * depth)));
    if (z === this.dragSlice()) return;
    this.dragSlice.set(z);
    this.volume.sliceSelectRequested$.next(z);
  }

  /** Pointer position in the output's unzoomed CSS px. */
  private localPoint(event: MouseEvent): { x: number; y: number } {
    const rect = this.outputRef()?.nativeElement.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const zoom = this.zoom();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  }

  onPointerLeave(): void {
    this.hover.set(null);
    this.pointer.set(null);
    this.projection.hoverColumn.set(null);
  }

  onClick(event: MouseEvent): void {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.painter.editing()) return;
    const at = this.locate(event);
    if (at) this.volume.sliceSelectRequested$.next(at.z);
  }


  // ==========================================
  // Internals
  // ==========================================

  /**
   * Builds the WebGL renderer, fetching three.js on first use.
   *
   * The import is dynamic so three.js sits in its own chunk instead of the
   * initial bundle: this view is behind an experimental flag, and most sessions
   * never open it.
   */
  private async createRenderer(): Promise<void> {
    const canvas = this.canvasRef()?.nativeElement;
    const viewport = this.viewportRef()?.nativeElement;
    if (!canvas || !viewport) return;
    const { ProjectionRenderer } = await import('./projection-renderer');
    if (this.destroyed) return;
    this.zone.runOutsideAngular(() => {
      this.renderer = new ProjectionRenderer(canvas);
    });
    this.observeViewport();
    this.applySettings(this.settings());
    this.syncLabels();
    const columns = this.projection.columns();
    this.renderer!.setColumns(columns?.ends ?? null, columns?.count ?? 0);
    if (this.volume.status() === 'ready' && this.volume.imageReady()) this.loadVolume();
  }

  /** The view moved to another window (detached / re-docked). */
  relocated(detached: boolean): void {
    this.detached.set(detached);
    this.observeViewport();
    this.renderer?.requestRender();
  }

  /** Follow the viewport's size, with the observer of its current window. */
  private observeViewport(): void {
    const viewport = this.viewportRef()?.nativeElement;
    if (!viewport) return;
    this.stopObserving?.();
    this.zone.runOutsideAngular(() => {
      this.stopObserving = observeSize(viewport, (width, height) =>
        this.zone.run(() => this.viewport.set({ width, height })),
      );
    });
  }

  private loadVolume(): void {
    const renderer = this.renderer;
    const { width: w, height: h, depth: d, image, masks } = this.volume;
    if (!renderer || !image) return;
    if (!renderer.supports(w, h, d)) {
      this.unsupported.set(true);
      return;
    }
    this.unsupported.set(false);
    const bits = new Uint8Array(w * h * d);
    masks.slice(0, MAX_PROJECTED_LABELS).forEach((mask, l) => {
      const bit = 1 << l;
      for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) bits[i] |= bit;
    });
    this.labelBits = bits;
    renderer.setVolume(image, bits, w, h, d);
    this.syncLabels();
    this.layout();
  }

  private unloadVolume(): void {
    this.labelBits = null;
    this.dirtySlices.clear();
    this.renderer?.clearVolume();
  }

  /** Rebuild the label bits of edited slices, once per animation frame. */
  private queueSlice(z: number): void {
    if (!this.labelBits) return;
    this.dirtySlices.add(z);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.nextFrame(() => {
      this.flushScheduled = false;
      const bits = this.labelBits;
      if (!bits) return;
      const size = this.volume.sliceSize;
      const masks = this.volume.masks.slice(0, MAX_PROJECTED_LABELS);
      for (const slice of this.dirtySlices) {
        const start = slice * size;
        bits.fill(0, start, start + size);
        masks.forEach((mask, l) => {
          const bit = 1 << l;
          for (let i = start; i < start + size; i++) if (mask[i] !== 0) bits[i] |= bit;
        });
        this.renderer?.updateLabelSlice(slice);
      }
      this.dirtySlices.clear();
    });
  }

  private applySettings(s: Volume3dSettings): void {
    this.renderer?.setStyle({
      mode: s.projectionMode,
      windowLow: s.windowLow,
      windowHigh: s.windowHigh,
      showLabels: s.projectionLabels,
      labelOpacity: s.projectionLabelOpacity,
      depth: s.projectionDepth,
    });
  }

  private syncLabels(): void {
    this.renderer?.setLabels(
      this.labels.listSegmentationLabels.map((l) => ({ color: l.color, visible: l.isVisible })),
    );
  }

  /** Fit the output (columns × slices, slices scaled by the spacing). */
  private layout(): void {
    const out = this.renderer?.outputSize;
    const { width, height } = this.viewport();
    if (!out || !out.width || !out.height || !width || !height) {
      this.display.set({ width: 0, height: 0 });
      return;
    }
    const tall = out.height * this.settings().zSpacing;
    const scale = Math.min(width / out.width, height / tall);
    this.display.set({ width: Math.floor(out.width * scale), height: Math.floor(tall * scale) });
  }

  /** Fractional projection position (column, slice) under the pointer,
   *  pixel centres at integers; clamped to the output unless `strict`. */
  private locateExact(event: MouseEvent, strict = true): { col: number; z: number } | null {
    const canvas = this.canvasRef()?.nativeElement;
    const out = this.renderer?.outputSize;
    if (!canvas || !out || !out.width || !out.height) return null;
    const rect = canvas.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    if (strict && (u < 0 || u >= 1 || v < 0 || v >= 1)) return null;
    return { col: u * out.width - 0.5, z: v * out.height - 0.5 };
  }

  private locate(event: MouseEvent): { column: number; z: number } | null {
    const canvas = this.canvasRef()?.nativeElement;
    const out = this.renderer?.outputSize;
    if (!canvas || !out || !out.width || !out.height) return null;
    const rect = canvas.getBoundingClientRect();
    const u = (event.clientX - rect.left) / rect.width;
    const v = (event.clientY - rect.top) / rect.height;
    if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
    return { column: Math.floor(u * out.width), z: Math.floor(v * out.height) };
  }
}
