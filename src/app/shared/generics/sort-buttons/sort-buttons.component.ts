import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { ButtonGroupModule } from 'primeng/buttongroup';
import { TooltipModule } from 'primeng/tooltip';

import { WorklistService } from '../../../services/worklist.service';

/**
 * One button per field the sequences can be sorted by, on the shared
 * worklist: the gallery and the inspector show the same sort.
 *
 * Each click steps a field through off → ascending → descending → off. A
 * field turned on sorts after those already on; its number in the sort is
 * shown when there are several.
 */
@Component({
  selector: 'app-sort-buttons',
  imports: [NgTemplateOutlet, ButtonModule, ButtonGroupModule, TooltipModule],
  templateUrl: './sort-buttons.component.html',
  styleUrl: './sort-buttons.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SortButtonsComponent {
  readonly worklist = inject(WorklistService);

  /** Smaller buttons, for a side panel. */
  readonly compact = input(false);
  /** The sort changed. */
  readonly changed = output<void>();

  /** Each field's level in the sort (1 for the first), by field id. */
  readonly ranks = computed(
    () => new Map(this.worklist.sortKeys().map((key, i) => [key.field, i + 1])),
  );

  cycle(field: string): void {
    this.worklist.cycleSort(field);
    this.changed.emit();
  }

  clear(): void {
    this.worklist.clearSort();
    this.changed.emit();
  }

  icon(field: string): string | undefined {
    const key = this.worklist.sortKeyOf(field);
    if (!key) return undefined;
    return key.descending ? 'pi pi-sort-amount-down' : 'pi pi-sort-amount-up-alt';
  }

  /** The level shown on the button, when several fields are sorted by. */
  badge(field: string): string | undefined {
    if (this.worklist.sortKeys().length < 2) return undefined;
    const rank = this.ranks().get(field);
    return rank === undefined ? undefined : String(rank);
  }

  tooltip(field: string, label: string): string {
    const key = this.worklist.sortKeyOf(field);
    if (!key) return `Sort by ${label}`;
    return key.descending
      ? `${label}, descending. Click to stop sorting by it`
      : `${label}, ascending. Click for descending`;
  }
}
