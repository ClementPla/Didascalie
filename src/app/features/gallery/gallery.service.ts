import { Injectable, signal } from '@angular/core';
import { ProjectScoped } from '../../core/project-scoped';
import { SequenceStatus } from '../../core/sequence-status';

export type KeypointFilter = 'all' | 'with' | 'without';

/** In a class filter: the sequences no frame of which answers the task. */
export const NO_CLASS = '\u0000unanswered';

@Injectable({
  providedIn: 'root',
})
export class GalleryService implements ProjectScoped {
  /** Signals: the gallery template reads these directly, under OnPush. */
  readonly itemPerPage = signal(64);

  // Filter and view state, kept across gallery <-> editor navigation.
  readonly filterTitle = signal('');
  readonly selectedStatuses = signal<SequenceStatus[]>([]);
  readonly keypointFilter = signal<KeypointFilter>('all');
  readonly frameCountRange = signal<number[]>([0, 0]);
  readonly frameRangeInitialized = signal(false);
  readonly showAdvancedFilters = signal(false);
  /** Classification task -> the classes wanted (any of them; `NO_CLASS` for
   *  unanswered). A task without an entry, or an empty one, is not filtered. */
  readonly classFilters = signal<Record<string, string[]>>({});
  /** Regression task -> the wanted `[lowest, highest]` value. A task without
   *  an entry is not filtered. */
  readonly regressionRanges = signal<Record<string, [number, number]>>({});
  readonly imgSize = signal(256);

  readonly viewLayout = signal<'grid' | 'list'>('grid');

  /** Index of the first item on the shown page. */
  readonly first = signal(0);

  /** Sequences ticked for batch actions, kept across gallery <-> editor
   *  navigation. Mutated in place by the gallery. */
  selectedIds: number[] = [];

  /**
   * @see ProjectScoped
   *
   * Filters, paging and the selection are reset. `imgSize`, `viewLayout`
   * and `itemPerPage` are user preferences and are kept. The sort lives on
   * the `WorklistService`.
   */
  resetForProject(): void {
    this.filterTitle.set('');
    this.selectedStatuses.set([]);
    this.keypointFilter.set('all');
    this.frameCountRange.set([0, 0]);
    this.frameRangeInitialized.set(false);
    this.showAdvancedFilters.set(false);
    this.classFilters.set({});
    this.regressionRanges.set({});
    this.first.set(0);
    this.selectedIds = [];
  }
}
