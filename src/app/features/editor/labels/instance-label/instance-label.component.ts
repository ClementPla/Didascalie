import { ChangeDetectorRef, Component, OnDestroy, OnInit, inject, input } from '@angular/core';
import { Subject, merge } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { NgClass } from '@angular/common';
import { TooltipModule } from 'primeng/tooltip';

import { SegLabel } from '../../../../core/interface';
import { generate_shades } from '../../../../core/misc/colors';
import { LabelsService } from '../../../../services/labels/labels.service';
import { IOService } from '../../../../services/io.service';
import { CanvasManagerService } from '../../drawable-canvas/service/canvas-manager.service';
import { DrawService } from '../../drawable-canvas/service/draw.service';
import { UndoRedoService } from '../../drawable-canvas/service/undo-redo.service';

/**
 * Instance picker of one label. Ids are 1-based (the id is the pixel value)
 * and each has a fixed shade of the label colour. Shown: the instances on the
 * current frame, plus the selected "next" one.
 */
@Component({
  selector: 'app-instance-label',
  imports: [NgClass, TooltipModule],
  templateUrl: './instance-label.component.html',
  styleUrl: './instance-label.component.scss',
})
export class InstanceLabelComponent implements OnInit, OnDestroy {
  labelService = inject(LabelsService);
  private canvasManager = inject(CanvasManagerService);
  private ioService = inject(IOService);
  private drawService = inject(DrawService);
  private undoRedo = inject(UndoRedoService);
  private cdr = inject(ChangeDetectorRef);

  readonly label = input.required<SegLabel>();
  /** One scrolling line of tiles, without the heading and the hint. */
  readonly compact = input(false);

  /** Instance ids painted on this label's mask. */
  private usedInstances = new Set<number>();
  private readonly destroy$ = new Subject<void>();

  ngOnInit(): void {
    this.recomputeUsed();
    // Rescan when masks change (frame load, stroke, undo/redo), debounced.
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

  private recomputeUsed(): void {
    const index = this.labelService.listSegmentationLabels.indexOf(this.label());
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

  /** Painted instances plus the selected one. */
  instanceValues(): number[] {
    const ids = new Set(this.usedInstances);
    const active = this.activeInstance();
    if (active && active >= 1) ids.add(active);
    return [...ids].sort((a, b) => a - b);
  }

  private shades(): string[] {
    const label = this.label();
    if (!label.shades || label.shades.length === 0) {
      label.shades = generate_shades(label.color, 256);
    }
    return label.shades;
  }

  shadeFor(value: number): string {
    const shades = this.shades();
    return shades[value] ?? shades[value % shades.length] ?? this.label().color;
  }

  /** The instance id selected for this label, or null if none / another label. */
  activeInstance(): number | null {
    const inst = this.labelService.activeSegInstance;
    return inst && inst.label === this.label() && inst.instance >= 1 ? inst.instance : null;
  }

  isSelected(value: number): boolean {
    return this.activeInstance() === value;
  }

  changeActive(value: number): void {
    this.labelService.activate(this.label(), value, this.shadeFor(value));
  }

  /** The id the "+" tile selects: one past the highest painted instance, so
   *  repeated clicks keep pointing at the same id. */
  nextInstanceId(): number {
    let max = 0;
    for (const v of this.usedInstances) if (v > max) max = v;
    return Math.min(255, max + 1);
  }

  /** Select the next unpainted instance id, and this label. */
  newInstance(): void {
    this.changeActive(this.nextInstanceId());
  }
}
