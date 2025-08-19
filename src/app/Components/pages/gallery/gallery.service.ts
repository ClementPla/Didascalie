import { Injectable } from '@angular/core';
import { ProjectService } from '../../../Services/Project/project.service';

@Injectable({
  providedIn: 'root',
})
export class GalleryService {
  first: number = 0;
  itemPerPage: number = 16;
  constructor(private projectService: ProjectService) {}

  getFirstPage() {
    const activeIndex = this.projectService.activeIndex;
    if (activeIndex) {
      // Calculate the first page based on the active index and items per page
      return activeIndex;
    }
    return 0;
  }
}
