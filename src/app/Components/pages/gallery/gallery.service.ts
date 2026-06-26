import { Injectable } from '@angular/core';
import { SequenceService } from '../../../Services/sequence.service';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

/** Keypoint presence filter: show all, only sequences with keypoints, or only those without. */
export type KeypointFilter = 'all' | 'with' | 'without';

@Injectable({
  providedIn: 'root',
})
export class GalleryService {
  itemPerPage = 64;

  // Persisted filter / view state (survives gallery <-> editor navigation)
  filterTitle = '';
  selectedStatuses: SequenceStatus[] = [];
  keypointFilter: KeypointFilter = 'all';
  sortKey = 'name-asc';
  frameCountRange: number[] = [0, 0];
  frameRangeInitialized = false;
  showAdvancedFilters = false;
  imgSize = 256;

  // Grid (thumbnail cards) vs list (rows) layout.
  viewLayout: 'grid' | 'list' = 'grid';

  // Explicit page set by user pagination. null = fall back to active-frame.
  private explicitFirst: number | null = null;

  constructor(private sequenceService: SequenceService) {
    sequenceService.loadSequences();
  }

  setFirstPage(first: number): void {
    this.explicitFirst = first;
  }

  getFirstPage(): number {
    if (this.explicitFirst !== null) {
      return this.explicitFirst;
    }
    const activeIndex = this.sequenceService.currentFrameIndex();
    if (activeIndex > 0) {
      return Math.floor(activeIndex / this.itemPerPage) * this.itemPerPage;
    }
    return 0;
  }

  getTotalFrames(): number {
    return this.sequenceService.frameCount();
  }

  getCurrentPage(): number {
    return Math.floor(
      this.sequenceService.currentFrameIndex() / this.itemPerPage,
    );
  }

  getTotalPages(): number {
    return Math.ceil(this.getTotalFrames() / this.itemPerPage);
  }
}