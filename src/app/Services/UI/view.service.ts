import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { ProjectService } from '../Project/project.service';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../../Core/save_load';
import { BehaviorSubject, Subject } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class ViewService {
  isLoading: boolean = false;
  loadingStatus: string = '';
  thumbnailsSize: number = 128;

  updatedImage: Subject<boolean> = new Subject<boolean>();

  constructor(private router: Router, private projectService: ProjectService) {}

  setLoading(status: boolean, message: string) {
    this.isLoading = status;
    this.loadingStatus = message;
  }

  endLoading() {
    this.isLoading = false;
    this.loadingStatus = '';
  }

  navigateToGallery() {
    return this.router.navigate(['/gallery']);
  }

  navigateToEditor() {
    return this.router.navigate(['/editor']);
  }

  navigateToExport() {
    this.router.navigate(['/export']);
  }

  async goNext() {
    if (
      this.projectService.activeIndex != null &&
      this.projectService.activeIndex <
        this.projectService.imagesName.length - 1
    ) {
      await this.openEditor(this.projectService.activeIndex + 1);
    }
  }

  async goPrevious() {
    if (
      this.projectService.activeIndex != null &&
      this.projectService.activeIndex > 0
    ) {
      await this.openEditor(this.projectService.activeIndex - 1);
    }
  }

  async openEditor(index: number) {
    this.projectService.activeIndex = index;
    const openPromise$ = path
      .join(
        this.projectService.inputFolder,
        this.projectService.imagesName[index]
      )
      .then(async (filepath) => {
        this.projectService.activeImage = await loadImageFile(filepath);
        this.navigateToEditor()?.then(() => {
          this.endLoading();
        });
      });
    await openPromise$;
    this.updatedImage.next(true);

  }
}
