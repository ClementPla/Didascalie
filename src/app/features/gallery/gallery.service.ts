import { Injectable, inject, signal } from '@angular/core';
import { SequenceService } from '../../services/sequence.service';
import { ProjectScoped } from '../../core/project-scoped';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

export type KeypointFilter = 'all' | 'with' | 'without';

@Injectable({
  providedIn: 'root',
})
export class GalleryService implements ProjectScoped {
  private sequenceService = inject(SequenceService);

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

  // Page set by the user. null: the page of the active frame.
  private readonly explicitFirst = signal<number | null>(null);

  /**
   * @see ProjectScoped
   *
   * Filters and paging are reset. `imgSize`, `viewLayout`, `sortKey` and
   * `itemPerPage` are user preferences and are kept.
   */
  resetForProject(): void {
    this.filterTitle.set('');
    this.selectedStatuses.set([]);
    this.keypointFilter.set('all');
    this.frameCountRange.set([0, 0]);
    this.frameRangeInitialized.set(false);
    this.showAdvancedFilters.set(false);
    this.explicitFirst.set(null);
  }

  setFirstPage(first: number): void {
    this.explicitFirst.set(first);
  }

  getFirstPage(): number {
    const explicit = this.explicitFirst();
    if (explicit !== null) {
      return explicit;
    }
    const activeIndex = this.sequenceService.currentFrameIndex();
    if (activeIndex > 0) {
      return Math.floor(activeIndex / this.itemPerPage()) * this.itemPerPage();
    }
    return 0;
  }

  getTotalFrames(): number {
    return this.sequenceService.frameCount();
  }

  getCurrentPage(): number {
    return Math.floor(
      this.sequenceService.currentFrameIndex() / this.itemPerPage(),
    );
  }

  getTotalPages(): number {
    return Math.ceil(this.getTotalFrames() / this.itemPerPage());
  }
}
