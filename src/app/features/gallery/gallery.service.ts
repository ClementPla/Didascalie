import { Injectable, inject, signal } from '@angular/core';
import { SequenceService } from '../../services/sequence.service';
import { ProjectScoped } from '../../core/project-scoped';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

/** Keypoint presence filter: show all, only sequences with keypoints, or only those without. */
export type KeypointFilter = 'all' | 'with' | 'without';

@Injectable({
  providedIn: 'root',
})
export class GalleryService implements ProjectScoped {
  private sequenceService = inject(SequenceService);

  /**
   * Signals rather than plain fields. The gallery template reads all of this
   * directly, and reading a signal marks that view dirty when it changes —
   * a plain property does not, so the component could not use OnPush.
   */
  readonly itemPerPage = signal(64);

  // Persisted filter / view state (survives gallery <-> editor navigation)
  readonly filterTitle = signal('');
  readonly selectedStatuses = signal<SequenceStatus[]>([]);
  readonly keypointFilter = signal<KeypointFilter>('all');
  readonly sortKey = signal('name-asc');
  readonly frameCountRange = signal<number[]>([0, 0]);
  readonly frameRangeInitialized = signal(false);
  readonly showAdvancedFilters = signal(false);
  readonly imgSize = signal(256);

  // Grid (thumbnail cards) vs list (rows) layout.
  readonly viewLayout = signal<'grid' | 'list'>('grid');

  // Explicit page set by user pagination. null = fall back to active-frame.
  private readonly explicitFirst = signal<number | null>(null);

  /**
    * No project I/O here: the service is `ProjectScoped`, so a reset can be what
    * first constructs it, between one project closing and the next opening.
    * The gallery loads its own sequences when it initialises.
   */

  /**
   * @see ProjectScoped
   *
   * Filters and paging describe *this project's* sequences — a status filter or
   * a frame-count range carried into another project hides items for no visible
   * reason, which is the "gallery is wrong after switching" symptom.
   *
   * `imgSize`, `viewLayout`, `sortKey` and `itemPerPage` are deliberately left
   * alone. They are how the user likes the gallery to look, not facts about the
   * project, and resetting them would be its own small annoyance.
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
