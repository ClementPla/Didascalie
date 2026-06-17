import { Injectable } from '@angular/core';
import { SequenceService } from '../../../Services/sequence.service';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

@Injectable({
  providedIn: 'root',
})
export class GalleryService {
  itemPerPage = 64;

  // Persisted filter / view state (survives gallery <-> editor navigation)
  filterTitle = '';
  selectedStatuses: SequenceStatus[] = [];
  sortKey = 'name-asc';
  frameCountRange: number[] = [0, 0];
  frameRangeInitialized = false;
  showAdvancedFilters = false;
  imgSize = 256;

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