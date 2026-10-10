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
  viewChild, ChangeDetectionStrategy } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { merge } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { MenuItem } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
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
import { CanvasInputDirective } from '../../../features/editor/drawable-canvas/directives/canvas-input.directive';
import { Point2D } from '../../../features/editor/drawable-canvas/interface';
import { labelPickerItems } from '../../../features/editor/drawable-canvas/label-picker';
import { CanvasManagerService } from '../../../features/editor/drawable-canvas/service/canvas-manager.service';
import { DrawService } from '../../../features/editor/drawable-canvas/service/draw.service';
import { ImageAdjustmentService } from '../../../features/editor/drawable-canvas/service/image-adjustment/image-adjustment.service';
import { packRGBLUT } from '../../../features/editor/drawable-canvas/service/image-adjustment/image-processing.model';
import { StateManagerService } from '../../../features/editor/drawable-canvas/service/state-manager.service';
import { ZoomPanService } from '../../../features/editor/drawable-canvas/service/zoom-pan.service';
import { VolumeLayoutService } from '../volume-layout.service';
import { Volume3dSettings, Volume3dSettingsService } from '../volume3d-settings.service';
import { CURVE_COLORS } from './curve-overlay.component';
import { MAX_PROJECTED_LABELS } from './projection.constants';
import type { ProjectionRenderer } from './projection-renderer';
import { ProjectionPainterService } from './projection-painter.service';
import { CurveId, ProjectionService } from './projection.service';
import { Surface, rowToSlice } from './projection-surface';
import { SurfaceCanvasManager, SurfaceImage, provideSurfaceEditing } from './surface-editing';
import { frameScheduler, observeSize } from '../../../shared/detached-window/detached-window';
import { TAP_SLOP } from '../../../core/touch';
import { IS_MOBILE } from '../../../core/platform';

/**
 * The projection between the two curves: arc length across, slices down.
 * Hovering a column highlights its segment on the slice, clicking jumps the
 * editor to the slice under the pointer.
 *
 * With the pencil on, it is a canvas for the editor's raster tools: the view
 * has its own instances of the editor's drawing services, bound to the
 * projected surface (see `provideSurfaceEditing`), and takes input through the
 * same directive as the slice.
 */
@Component({
  selector: 'app-projection-view',
  standalone: true,
  imports: [FormsModule, ButtonModule, CanvasInputDirective, ContextMenuModule, MenuModule, PopoverModule, SelectModule, SliderModule, ToggleSwitchModule, TooltipModule],
  templateUrl: './projection-view.component.html',
  host: { class: 'flex flex-col min-h-0 min-w-0' },
  providers: [provideSurfaceEditing()],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectionViewComponent implements OnDestroy {
  readonly isMobile = IS_MOBILE;
  readonly volume = inject(MaskVolumeService);
  readonly projection = inject(ProjectionService);
  readonly painter = inject(ProjectionPainterService);
  readonly labels = inject(LabelsService);
  private readonly sequences = inject(SequenceService);
  readonly editor = inject(EditorService);
  private readonly settingsService = inject(Volume3dSettingsService);
  private readonly zone = inject(NgZone);
  // This view's own instances: they work on the projected surface.
  private readonly zoomPan = inject(ZoomPanService);
  private readonly surfaceState = inject(StateManagerService);
  private readonly surfaceCanvas = inject(CanvasManagerService) as SurfaceCanvasManager;
  private readonly draw = inject(DrawService);
  private readonly surfaceImage = inject(SurfaceImage);
  /** The editor's image adjustments (the slice canvas's instance). */
  private readonly adjustments = inject(ImageAdjustmentService, { skipSelf: true });

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
  private readonly strokeRef = viewChild<ElementRef<HTMLCanvasElement>>('stroke');
  private readonly labelMenu = viewChild<ContextMenu>('labelMenu');
  labelMenuItems: MenuItem[] = [];
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
  /** Size of the output: the surface, one CSS px per pixel before the view
   *  transform. */
  readonly display = computed(() => {
    const surface = this.painter.surface();
    return surface ? { width: surface.columns, height: surface.rows } : { width: 0, height: 0 };
  });
  private readonly viewport = signal({ width: 0, height: 0 });
  readonly hover = signal<{ column: number; z: number } | null>(null);
  /** Pointer position over the output, in surface pixels. */
  readonly pointer = signal<Point2D | null>(null);
  /** Outline of the lasso or line being drawn, in surface pixels. */
  readonly preview = signal<string | null>(null);
  readonly lastStroke = computed(() => this.painter.lastStrokeSlices());

  /** The view transform, mirrored from this view's `ZoomPanService`. */
  private readonly view = signal({ scale: 1, x: 0, y: 0 });
  readonly zoom = computed(() => this.view().scale);
  readonly transform = computed(() => {
    const { scale, x, y } = this.view();
    return `translate(${x}px, ${y}px) scale(${scale})`;
  });
  /** The whole projection is in view; it is then kept fitted as the pane or
   *  the surface changes size. */
  readonly fitted = signal(true);
  private lastSurface: Surface | null = null;
  /** The adjustments the renderer has: their version, or -1 for none. */
  private lutKey: number | null = null;
  private readonly outputRef = viewChild<ElementRef<HTMLDivElement>>('output');
  /** Where the pointer went down, and whether it then moved: a click that
   *  ends a drag must not jump slices. */
  private pressAt: Point2D | null = null;
  private dragged = false;

  /** The brush outline stands for the cursor: painting, with a tool that has
   *  a size. */
  readonly brushShown = computed(() => this.painter.editing() && this.editor.isToolWithBrushSize());

  /** Brush outline diameter, in surface pixels. */
  readonly brushDiameter = computed(() => this.editor.lineWidth);

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
      untracked(() => this.renderer?.setColumns(columns?.ends ?? null, columns?.count ?? 0));
    });

    effect(() => {
      const settings = this.settings();
      untracked(() => this.applySettings(settings));
    });

    // Follow the surface, and keep the output fitted as it or the pane resizes.
    effect(() => {
      const surface = this.painter.surface();
      const viewport = this.viewport();
      untracked(() => this.layout(surface, viewport));
    });

    // A dropped marker hands over once the editor shows its slice.
    effect(() => {
      const z = this.sequences.currentFrameIndex();
      untracked(() => {
        if (!this.draggingMarker && this.dragSlice() === z) this.dragSlice.set(null);
      });
    });

    this.volume.edited$.pipe(takeUntilDestroyed()).subscribe(({ z }) => this.queueSlice(z));
    // Also raised when the image adjustments change.
    this.editor.canvasRedraw.pipe(takeUntilDestroyed()).subscribe(() => {
      this.syncLabels();
      this.syncLut();
    });

    // Not eased: the easing runs on the main window's frames, which stop while
    // it is hidden, and this view may be detached.
    this.zoomPan.smooth = false;
    this.zoomPan.redrawRequest.pipe(takeUntilDestroyed()).subscribe(() => this.syncView());
    this.draw.previewPoints$
      .pipe(takeUntilDestroyed())
      .subscribe((points) =>
        this.preview.set(points.length > 1 ? points.map((p) => `${p.x},${p.y}`).join(' ') : null),
      );
    merge(this.draw.singleDrawRequest, this.draw.redrawRequest)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.drawStroke());
    this.surfaceImage.source = () => this.projectionImage();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.painter.setEditing(false);
    this.stopObserving?.();
    this.renderer?.dispose();
    this.projection.hoverColumn.set(null);
  }

  // ── Template actions ─────────────────────────────────────────────────────

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

  /** A press on the output; the directive decides what it does. */
  onPress(event: PointerEvent): void {
    this.pressAt = { x: event.clientX, y: event.clientY };
    this.dragged = false;
  }

  /** The pointer moved over the output (`coords` are surface pixels). */
  onCanvasMove(data: { event: MouseEvent; coords: Point2D }): void {
    const surface = this.painter.surface();
    this.zoomPan.currentPixel = data.coords;
    const raw = this.zoomPan.getImageCoordinatesRaw(data.event);
    const inside =
      !!surface && raw.x >= 0 && raw.y >= 0 && raw.x < surface.columns && raw.y < surface.rows;
    const at = inside
      ? { column: Math.floor(raw.x), z: rowToSlice(Math.floor(raw.y), surface) }
      : null;
    this.hover.set(at);
    this.projection.hoverColumn.set(at?.column ?? null);
    this.pointer.set(inside ? raw : null);

    const press = this.pressAt;
    if (press && Math.hypot(data.event.clientX - press.x, data.event.clientY - press.y) > TAP_SLOP) {
      this.dragged = true;
    }
    if (this.zoomPan.isDragging) this.zoomPan.drag(data.event);
    else if (this.painter.editing()) this.draw.draw(data.event);
  }

  openLabelPicker(event: MouseEvent): void {
    this.labelMenuItems = labelPickerItems(this.labels);
    this.labelMenu()?.show(event);
  }

  /**
   * Wheel zooms around the pointer; Ctrl+wheel resizes the brush (as on the
   * slice) and Shift+wheel moves the depth strokes are written at. Not Alt:
   * holding it opens the editor's quick-access menu.
   */
  onWheel(event: WheelEvent): void {
    event.preventDefault();
    if (event.shiftKey) {
      // Finer with Ctrl, for a thin structure between close curves.
      const step = event.ctrlKey ? 0.002 : 0.01;
      const depth = this.settings().projectionDepth + (event.deltaY > 0 ? -step : step);
      this.update({ projectionDepth: Math.min(1, Math.max(0, Number(depth.toFixed(3)))) });
      return;
    }
    if (event.ctrlKey && this.painter.editing()) {
      const step = Math.max(1, Math.round(this.editor.lineWidth * 0.1));
      this.editor.lineWidth = Math.max(1, this.editor.lineWidth + (event.deltaY > 0 ? -step : step));
      return;
    }
    this.zoomPan.wheel(event);
  }

  resetView(): void {
    this.zoomPan.resetZoomAndPan(false);
  }

  // ── Dragging the current-slice marker ────────────────────────────────────

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

  /** Pointer position in the output's own px, before the view transform. */
  private localPoint(event: MouseEvent): { x: number; y: number } {
    const rect = this.outputRef()?.nativeElement.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const zoom = this.zoom();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  }

  onPointerLeave(): void {
    this.pressAt = null;
    this.hover.set(null);
    this.pointer.set(null);
    this.projection.hoverColumn.set(null);
  }

  onClick(): void {
    this.pressAt = null;
    if (this.dragged || this.painter.editing()) return;
    const at = this.hover();
    if (at) this.volume.sliceSelectRequested$.next(at.z);
  }

  // ── Internals ────────────────────────────────────────────────────────────

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
    this.syncLut();
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
    this.zoomPan.setViewportRef(viewport);
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

  /** The editor's image adjustments, applied by the renderer. */
  private syncLut(): void {
    if (!this.renderer) return;
    const lut = this.adjustments.activeLUT();
    const key = lut ? this.adjustments.version : -1;
    if (key === this.lutKey) return;
    this.lutKey = key;
    this.renderer.setLut(lut ? packRGBLUT(lut) : null);
  }

  /** Bind the drawing services to the surface and keep the output fitted. */
  private layout(surface: Surface | null, viewport: { width: number; height: number }): void {
    this.zoomPan.setViewportSize(viewport.width, viewport.height);
    if (!surface) return;
    if (surface !== this.lastSurface) {
      this.lastSurface = surface;
      this.surfaceCanvas.invalidate();
      this.surfaceCanvas.sync();
    }
    if (this.fitted()) this.zoomPan.resetZoomAndPan(false);
  }

  /** Mirror the view transform, and note whether it is the fitted one. */
  private syncView(): void {
    const scale = this.zoomPan.getScale();
    const { x, y } = this.zoomPan.getOffset();
    this.view.set({ scale, x, y });
    const { width: vw, height: vh } = this.viewport();
    const { width, height } = this.display();
    if (!vw || !vh || !width || !height) return;
    const fit = Math.min(this.zoomPan.maxScale, Math.max(this.zoomPan.minScale, Math.min(vw / width, vh / height)));
    this.fitted.set(
      Math.abs(scale - fit) < fit * 1e-3 &&
        Math.abs(x - (vw - width * fit) / 2) < 1 &&
        Math.abs(y - (vh - height * fit) / 2) < 1,
    );
  }

  /** Show the stroke in progress, until the labels it wrote are drawn. */
  private drawStroke(): void {
    const canvas = this.strokeRef()?.nativeElement;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const clear = () => context.clearRect(0, 0, canvas.width, canvas.height);
    if (this.surfaceState.isDrawing) {
      clear();
      const origin = this.surfaceCanvas.getBufferOrigin();
      context.drawImage(this.surfaceCanvas.getBufferCanvas(), origin.x, origin.y);
    } else {
      this.nextFrame(() =>
        this.nextFrame(() => {
          if (!this.surfaceState.isDrawing) clear();
        }),
      );
    }
  }

  /** The projection without labels, at the surface's size, for the
   *  post-processing to read. */
  private projectionImage(): OffscreenCanvas | null {
    const surface = this.painter.surface();
    const source = this.renderer?.renderImage();
    if (!surface || !source) return null;
    const canvas = new OffscreenCanvas(surface.columns, surface.rows);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return null;
    context.imageSmoothingEnabled = false;
    context.drawImage(source, 0, 0, surface.columns, surface.rows);
    return canvas;
  }
}
