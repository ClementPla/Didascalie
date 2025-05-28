import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { ProjectService } from '../Project/project.service';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../../Core/save_load';
import { BehaviorSubject, Subject } from 'rxjs';
import { MultiframesService } from '../Project/multiframes.service';

@Injectable({
  providedIn: 'root',
})
export class ViewService {
  isLoading: boolean = false;
  loadingStatus: string = '';
  thumbnailsSize: number = 128;

  updatedImage: Subject<boolean> = new Subject<boolean>();

  constructor(
    private router: Router,
    private projectService: ProjectService,
    private multiframeService: MultiframesService
  ) {}

  setLoading(status: boolean, message: string) {
    this.isLoading = status;
    this.loadingStatus = message;
    console.log(`Loading status: ${this.loadingStatus}`);
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
    if (this.projectService.folderAsMultiframes) {
      const currentGroup = await this.multiframeService.activeGroup;
      // Find index of the current group
      let foundCurrent = false;
      let nextGroup: string | null = null;

      for (const group of this.multiframeService.groupedFrames.keys()) {
        if (foundCurrent) {
          nextGroup = group;
          break;
        }
        if (group === currentGroup) {
          foundCurrent = true;
        }
      }
      // If next group is not found, it means we are at the last group
      if (nextGroup === null) {
        return false;
      }

      if (nextGroup) {
        // Set the next group as active
        await this.multiframeService.setActiveGroup(nextGroup);
        // Get the first frame of the next group
        const frames = this.multiframeService.groupedFrames.get(nextGroup);
        if (frames) {
          const imageName = frames[0];
          const index = this.projectService.extractImagesName([imageName])[0];
          await this.openEditor(this.projectService.imagesName.indexOf(index));
          return true;
        }
      }
    }
    if (
      this.projectService.activeIndex != null &&
      this.projectService.activeIndex <
        this.projectService.imagesName.length - 1
    ) {
      await this.openEditor(this.projectService.activeIndex + 1);
      return true;
    }
    return false;
  }

  async goPrevious() {
    if (
      this.projectService.activeIndex != null &&
      this.projectService.activeIndex > 0
    ) {
      if (this.projectService.folderAsMultiframes) {
        const currentGroup = await this.multiframeService.activeGroup;
        // Find index of the current group
        let previousGroup: string | undefined = undefined;
        for (const group of this.multiframeService.groupedFrames.keys()) {
          if (group === currentGroup) {
            break;
          }
          previousGroup = group;
        }
        if (previousGroup === undefined) {
          // Set the previous group to the first one
          return false;
        }
        // Set the previous group as active
        await this.multiframeService.setActiveGroup(previousGroup!);
        // Get the last frame of the previous group
        const frames = this.multiframeService.groupedFrames.get(previousGroup!);
        if (frames) {
          const imageName = frames[0];
          const index = this.projectService.extractImagesName([imageName])[0];
          await this.openEditor(this.projectService.imagesName.indexOf(index));
          return true;
        }
      } else {
        await this.openEditor(this.projectService.activeIndex - 1);
        return true;
      }

    }
    return false;
  }

  async openEditor(index: number) {
    this.projectService.activeIndex = index;

    await this.multiframeService.setActiveGroupFromFilepath(
      this.projectService.imagesName[index]
    );

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
