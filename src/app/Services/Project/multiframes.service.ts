import { Injectable } from '@angular/core';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../../Core/save_load';
import { Subject } from 'rxjs';


@Injectable({
  providedIn: 'root',
})
export class MultiframesService {
  groupedFrames: Map<string, string[]> = new Map<string, string[]>();
  activeGroup: string = '';
  loadedFrames: Map<number, string> = new Map<number, string>(); // Store loaded frames for the current group
  inputFolder: string = ''; // Store the input folder path
  constructor() {}

  async groupFrames(inputFolder: string, fileList: string[]) {
    this.inputFolder = inputFolder; // Store the input folder path
    // Group frames if they have the same parent folder
    fileList.forEach(async (file) => {
      const parentFolder = await this.extractGroupName(file);
      if (!this.groupedFrames.has(parentFolder)) {
        this.groupedFrames.set(parentFolder, []);
      }
      // Add the file to the corresponding group if it not already present
      if (!this.groupedFrames.get(parentFolder)!.includes(file)) {
        // Avoid duplicates in the same group
        this.groupedFrames.get(parentFolder)!.push(file);
      }
    });
  }
  numberOfGroups(): number {
    return this.groupedFrames.size;
  }

  numberOfFramesInGroup(group: string): number {
    if (this.groupedFrames.has(group)) {
      return this.groupedFrames.get(group)!.length;
    }
    return 0;
  }
  async extractGroupName(filepath: string): Promise<string> {
    return path
      .dirname(filepath)
      // Normalize path for consistency
      .then((dir) => {
        let folder = dir.split(this.inputFolder)[1]; // Get the part after the input folder
        // Replace backslashes with forward slashes for consistency
        if (folder) {
          folder = folder.replace(/\\/g, '/');
        } else {
          // If input folder is not found in the path, use the full directory
          folder = dir;
        }
        return folder
      }); // Get parent folder name
  }

  async getGroupFrames(filepath: string) {
    const parentFolder = await this.extractGroupName(filepath);
    if (this.groupedFrames.has(parentFolder)) {
      return parentFolder;
    }
    return null;
  }

  async setActiveGroup(group: string) {
    this.activeGroup = group;
    this.loadedFrames = new Map<number, string>(); // Clear loaded frames when changing group
  }

  async setActiveGroupFromFilepath(filepath: string) {
    const currentGroup = await this.getGroupFrames(filepath);

    if (currentGroup) {
      await this.setActiveGroup(currentGroup);
    }
  }

  getLengthOfActiveGroup(): number {
    if (this.groupedFrames.has(this.activeGroup)) {
      return this.groupedFrames.get(this.activeGroup)!.length;
    }
    return 0;
  }

  async getFrameInActiveGroup(index: number): Promise<string | null> {
    if (!this.loadedFrames.has(index)) {
      const frames = this.groupedFrames.get(this.activeGroup)!;
      const frame = await loadImageFile(frames[index]);
      this.loadedFrames.set(index, frame);
    }
    return this.loadedFrames.get(index) || null;
  }

  getFrameNameInActiveGroup(index: number): string | null {
    if (this.groupedFrames.has(this.activeGroup)) {
      const frames = this.groupedFrames.get(this.activeGroup)!;
      if (index >= 0 && index < frames.length) {
        return frames[index];
      }
    }
    return null;
  }
  cacheActivegroupFrames() {
    // Cache all frames in the active group
    const frames = this.groupedFrames.get(this.activeGroup);
    if (frames) {
      frames.forEach(async (frame, index) => {
        if (!this.loadedFrames.has(index)) {
          const loadedFrame = await loadImageFile(frame);
          this.loadedFrames.set(index, loadedFrame);
        }
      });
    }
  }
}
