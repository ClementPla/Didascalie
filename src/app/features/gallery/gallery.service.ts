import { Injectable, signal } from '@angular/core';
import { ProjectScoped } from '../../core/project-scoped';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

export type KeypointFilter = 'all' | 'with' | 'without';

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
  readonly sortKey = signal('name-asc');
  readonly frameCountRange = signal<number[]>([0, 0]);
  readonly frameRangeInitialized = signal(false);
  readonly showAdvancedFilters = signal(false);
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
   * Filters, paging and the selection are reset. `imgSize`, `viewLayout`,
   * `sortKey` and `itemPerPage` are user preferences and are kept.
   */
  resetForProject(): void {
    this.filterTitle.set('');
    this.selectedStatuses.set([]);
    this.keypointFilter.set('all');
    this.frameCountRange.set([0, 0]);
    this.frameRangeInitialized.set(false);
    this.showAdvancedFilters.set(false);
    this.first.set(0);
    this.selectedIds = [];
  }
}
