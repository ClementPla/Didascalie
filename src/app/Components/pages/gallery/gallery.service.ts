import { Injectable } from '@angular/core';
import { SequenceService } from '../../../Services/sequence.service';

@Injectable({
  providedIn: 'root',
})
export class GalleryService {
  first: number = 0;
  itemPerPage: number = 64;

  constructor(private sequenceService: SequenceService) {}

  getFirstPage(): number {
    const activeIndex = this.sequenceService.currentFrameIndex();
    
    if (activeIndex > 0) {
      // Calculate the first page based on the active index and items per page
      const activePage = Math.floor(activeIndex / this.itemPerPage);
      return activePage * this.itemPerPage;
    }
    
    return 0;
  }

  getTotalFrames(): number {
    return this.sequenceService.frameCount();
  }

  getCurrentPage(): number {
    return Math.floor(this.sequenceService.currentFrameIndex() / this.itemPerPage);
  }

  getTotalPages(): number {
    return Math.ceil(this.getTotalFrames() / this.itemPerPage);
  }

}