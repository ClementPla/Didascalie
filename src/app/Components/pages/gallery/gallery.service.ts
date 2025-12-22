import { Injectable } from '@angular/core';
import { ProjectService } from '../../../Services/ProjectService/project.service';

@Injectable({
  providedIn: 'root',
})
export class GalleryService {
  first: number = 0;
  itemPerPage: number = 64;
  constructor(private projectService: ProjectService) {}

  getFirstPage() {
    const activeIndex = this.projectService.activeIndex;

    if (activeIndex) {
      // Calculate the first page based on the active index and items per page
      const activePage = Math.floor(activeIndex / this.itemPerPage);
      const activeFirst = activePage * this.itemPerPage;
      return activeFirst;
    } else {  
      return 0;
    }
  }
}
