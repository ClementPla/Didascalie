import {
  ChangeDetectorRef,
  Component,
  Input,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { Subject, merge } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { NgClass } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';

import { SegLabel } from '../../../../../Core/interface';
import { generate_shades } from '../../../../../Core/misc/colors';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { IOService } from '../../../../../Services/io.service';
import { CanvasManagerService } from '../../drawable-canvas/service/canvas-manager.service';
import { DrawService } from '../../drawable-canvas/service/draw.service';
import { UndoRedoService } from '../../drawable-canvas/service/undo-redo.service';

/**
 * Instance picker for one label. Instance ids are 1-based (the id IS the pixel
 * value, so 0 is reserved for background), and each id maps to a stable,
 * deterministic shade of the label colour. The picker shows only the instances
 * that exist on the current frame plus the currently-selected "next" one, so it
 * grows with use instead of listing a fixed 99.
 */
@Component({
  selector: 'app-instance-label',
  imports: [NgClass, TooltipModule],
  templateUrl: './instance-label.component.html',
  styleUrl: './instance-label.component.scss',
})
export class InstanceLabelComponent implements OnInit, OnDestroy {
  @Input() label!: SegLabel;

  /** Instance ids currently painted on this label's mask (recomputed lazily). */
  private usedInstances = new Set<number>();
  private readonly destroy$ = new Subject<void>();

  constructor(
    public labelService: LabelsService,
    private canvasManager: CanvasManagerService,
    private ioService: IOService,
    private drawService: DrawService,
    private undoRedo: UndoRedoService,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnInit(): void {
    this.recomputeUsed();
    // Refresh the used-instance list when masks change: after a frame loads, a
    // stroke commits, or an undo/redo restores. Debounced so a burst collapses
    // into one scan.
    merge(
      this.ioService.loaded$,
      this.drawService.redrawRequest,
      this.undoRedo.redrawRequest,
    )
      .pipe(debounceTime(60), takeUntil(this.destroy$))
      .subscribe(() => {
        this.recomputeUsed();
        this.cdr.markForCheck();
      });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /** Scan this label's mask for the distinct instance ids in use. */
  private recomputeUsed(): void {
    const index = this.labelService.listSegmentationLabels.indexOf(this.label);
    const mask = index >= 0 ? this.canvasManager.getAllMasks()[index] : undefined;
    const used = new Set<number>();
    if (mask) {
      for (let i = 0; i < mask.length; i++) {
        const v = mask[i];
        if (v !== 0) used.add(v);
      }
    }
    this.usedInstances = used;
  }

  /** Ids to show: painted instances plus the currently-selected one. Empty when
   *  nothing is painted or selected — the "+" tile is then the only entry. */
  instanceValues(): number[] {
    const ids = new Set(this.usedInstances);
    const active = this.activeInstance();
    if (active && active >= 1) ids.add(active);
    return [...ids].sort((a, b) => a - b);
  }

  private shades(): string[] {
    // Instance labels get their shades at project load; regenerate once only if
    // somehow missing (deterministic, so this stays stable).
    if (!this.label.shades || this.label.shades.length === 0) {
      this.label.shades = generate_shades(this.label.color, 256);
    }
    return this.label.shades;
  }

  shadeFor(value: number): string {
    const shades = this.shades();
    return shades[value] ?? shades[value % shades.length] ?? this.label.color;
  }

  /** The instance id selected for this label, or null if none / another label. */
  activeInstance(): number | null {
    const inst = this.labelService.activeSegInstance;
    return inst && inst.label === this.label && inst.instance >= 1 ? inst.instance : null;
  }

  isSelected(value: number): boolean {
    return this.activeInstance() === value;
  }

  changeActive(value: number): void {
    this.labelService.activeLabel = this.label;
    this.labelService.activeSegInstance = {
      label: this.label,
      instance: value,
      shade: this.shadeFor(value),
      id: this.label.id,
    };
  }

  /**
   * The id the "+" tile will select: one past the highest *painted* instance.
   * Deliberately ignores the currently-selected (but not-yet-painted) instance,
   * so clicking "+" repeatedly keeps pointing at the same fresh id instead of
   * skipping ids and abandoning the one just selected.
   */
  nextInstanceId(): number {
    let max = 0;
    for (const v of this.usedInstances) if (v > max) max = v;
    return Math.min(255, max + 1);
  }

  /** Select the next unpainted instance id (activating this label). The next
   *  stroke then paints a fresh object. Idempotent until that stroke lands. */
  newInstance(): void {
    this.changeActive(this.nextInstanceId());
  }
}
