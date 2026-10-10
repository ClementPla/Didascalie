import { Injectable, Provider, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { commitStroke, intRect } from '../../../core/misc/label-ops';
import { PostProcessOption } from '../../../core/tools';
import { LabelsService } from '../../../services/labels/labels.service';
import { MaskVolumeService } from '../../../services/mask-volume.service';
import { ProjectService } from '../../../services/project/project.service';
import { CanvasManagerService } from '../../../features/editor/drawable-canvas/service/canvas-manager.service';
import { DrawService } from '../../../features/editor/drawable-canvas/service/draw.service';
import { ImageAdjustmentService } from '../../../features/editor/drawable-canvas/service/image-adjustment/image-adjustment.service';
import { PostProcessService } from '../../../features/editor/drawable-canvas/service/post-process.service';
import { StateManagerService } from '../../../features/editor/drawable-canvas/service/state-manager.service';
import { UndoRedoService } from '../../../features/editor/drawable-canvas/service/undo-redo.service';
import { ZoomPanService } from '../../../features/editor/drawable-canvas/service/zoom-pan.service';
import { EditorService } from '../../../features/editor/services/editor.service';
import { ProjectionPainterService } from './projection-painter.service';

/**
 * The editor's drawing pipeline, a second time, for the projection view.
 *
 * The slice canvas owns one instance of each editor service. The projection
 * view provides its own (`provideSurfaceEditing`), bound to the flattened
 * surface instead of a frame, so the same tools, post-processing and input
 * handling run on it unchanged. What differs is at the edges, in the classes
 * below: the masks are sampled from the volume, the image comes from the
 * projection renderer, and a finished stroke is written back to the volume
 * instead of being snapshotted.
 *
 * Tools, labels, undo and saving stay the application's own: one tool rail,
 * one undo timeline.
 */
export function provideSurfaceEditing(): Provider[] {
  return [
    StateManagerService,
    ZoomPanService,
    { provide: CanvasManagerService, useClass: SurfaceCanvasManager },
    { provide: DrawService, useClass: SurfaceDrawService },
    { provide: PostProcessService, useClass: SurfacePostProcess },
    SurfaceImage,
    { provide: ImageAdjustmentService, useExisting: SurfaceImage },
    SurfaceHistory,
    { provide: UndoRedoService, useExisting: SurfaceHistory },
  ];
}

/** The label layers of the surface, and the stroke buffer the tools draw on. */
@Injectable()
export class SurfaceCanvasManager extends CanvasManagerService {
  private readonly painter = inject(ProjectionPainterService);
  private readonly surfaceState = inject(StateManagerService);
  /** The volume changed since the layers were read from it. */
  private stale = true;

  constructor() {
    super();
    // Never composited here: the projection renderer draws the labels.
    this.useViewportComposite = true;
    inject(MaskVolumeService)
      .edited$.pipe(takeUntilDestroyed())
      .subscribe(() => (this.stale = true));
  }

  /** The slice canvas owns the GPU compositor. */
  protected override async initializeWebGPU(): Promise<void> {}
  override async computeCombinedCanvas(): Promise<void> {}

  /** Read the layers again from the volume, on the current surface. */
  sync(force = false): void {
    const surface = this.painter.surface();
    if (!surface) return;
    const { columns, rows } = surface;
    const resized = columns !== this.surfaceState.width || rows !== this.surfaceState.height;
    if (!force && !resized && !this.stale) return;
    this.surfaceState.setWidthAndHeight(columns, rows);
    this.ensureAuxCanvases(columns, rows);
    this.bindMasks(this.painter.sample(surface));
    this.stale = false;
  }

  /** The surface moved (curves, depth, spacing): its layers are out of date. */
  invalidate(): void {
    this.stale = true;
  }
}

/** A stroke starts from the volume as it is, and tells no one but the view. */
@Injectable()
export class SurfaceDrawService extends DrawService {
  private readonly surfaceCanvas = inject(CanvasManagerService) as SurfaceCanvasManager;

  /** Clearing and recolouring are the slice canvas's business. */
  protected override initializeSubscriptions(): void {}

  override startDraw(event: MouseEvent): void {
    this.surfaceCanvas.sync();
    super.startDraw(event);
  }

  /** An abandoned stroke may already have erased from the layers. */
  override cancelDraw(): void {
    super.cancelDraw();
    this.surfaceCanvas.invalidate();
  }
}

/** Otsu and flood fill run on the projection; the model-based modes need a
 *  frame, so a stroke is kept as drawn. */
@Injectable()
export class SurfacePostProcess extends PostProcessService {
  private readonly editor = inject(EditorService);
  private readonly canvas = inject(CanvasManagerService);
  private readonly state = inject(StateManagerService);
  private readonly labels = inject(LabelsService);
  private readonly project = inject(ProjectService);

  override async getPostProcessFunction(): Promise<void> {
    const option = this.editor.postProcessOption;
    if (option === PostProcessOption.OTSU || option === PostProcessOption.FLOODFILL) {
      return super.getPostProcessFunction();
    }
    const { width, height } = this.state;
    const rect = intRect(this.state.getBoundingBox(), width, height);
    const mask = this.canvas.getActiveMask();
    if (!rect || !mask) return;
    commitStroke(
      mask,
      width,
      this.canvas.readBufferRegion(rect),
      rect,
      this.labels.paintValue(this.project.isInstanceSegmentation()),
    );
  }
}

/** The image the post-processing reads: the projection, without its labels. */
@Injectable()
export class SurfaceImage implements Pick<ImageAdjustmentService, 'getCurrentCanvas'> {
  /** Set by the view, which owns the renderer. */
  source: (() => HTMLCanvasElement | OffscreenCanvas | null) | null = null;

  getCurrentCanvas(): HTMLCanvasElement | OffscreenCanvas | null {
    return this.source?.() ?? null;
  }
}

/** A finished stroke goes to the volume, which records it for undo. */
@Injectable()
export class SurfaceHistory implements Pick<UndoRedoService, 'updateUndoRedo'> {
  private readonly painter = inject(ProjectionPainterService);
  private readonly canvas = inject(CanvasManagerService) as SurfaceCanvasManager;

  async updateUndoRedo(): Promise<void> {
    this.painter.commit(this.canvas.getAllMasks());
    this.canvas.sync(true);
  }
}
