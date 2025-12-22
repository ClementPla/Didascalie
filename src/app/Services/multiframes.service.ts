import { Injectable } from '@angular/core';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../Core/save_load';

@Injectable({
  providedIn: 'root',
})
export class MultiframesService {
  private _groupedFrames = new Map<string, string[]>();
  private _activeGroup = '';
  private _loadedFrames = new Map<number, string>();
  private _inputFolder = '';

  // ==========================================
  // Public Accessors
  // ==========================================

  get groupedFrames(): ReadonlyMap<string, string[]> {
    return this._groupedFrames;
  }

  get activeGroup(): string {
    return this._activeGroup;
  }

  get inputFolder(): string {
    return this._inputFolder;
  }

  public getLengthOfActiveGroup(): number {
    return this._groupedFrames.get(this._activeGroup)?.length ?? 0;
  }

  // ==========================================
  // Group Management
  // ==========================================

  /**
   * Groups frames by their parent folder structure.
   * @param inputFolder - Base input folder path
   * @param fileList - List of file paths to group
   */
  async groupFrames(inputFolder: string, fileList: string[]): Promise<void> {
    this._inputFolder = inputFolder;
    this._groupedFrames.clear();

    // Process all files and extract their group names
    const fileGroups = await Promise.all(
      fileList.map(async (file) => ({
        file,
        group: await this.extractGroupName(file),
      }))
    );

    // Group files by their extracted group name
    for (const { file, group } of fileGroups) {
      const existingGroup = this._groupedFrames.get(group);

      if (existingGroup) {
        // Avoid duplicates
        if (!existingGroup.includes(file)) {
          existingGroup.push(file);
        }
      } else {
        this._groupedFrames.set(group, [file]);
      }
    }

    // Sort frames within each group
    await this.sortAllGroups();
  }

  /**
   * Sorts all frames within each group alphabetically by filename.
   */
  private async sortAllGroups(): Promise<void> {
    for (const [group, frames] of this._groupedFrames) {
      const sortedFrames = await this.sortFramesByBasename(frames);
      this._groupedFrames.set(group, sortedFrames);
    }
  }

  /**
   * Sorts frames alphabetically by their basename.
   */
  private async sortFramesByBasename(frames: string[]): Promise<string[]> {
    const framesWithBasenames = await Promise.all(
      frames.map(async (frame) => ({
        frame,
        basename: (await path.basename(frame)).toLowerCase(),
      }))
    );

    framesWithBasenames.sort((a, b) => a.basename.localeCompare(b.basename));

    return framesWithBasenames.map((item) => item.frame);
  }

  /**
   * Extracts the group name from a filepath.
   * The group name is the relative path from the input folder.
   */
  async extractGroupName(filepath: string): Promise<string> {
    const dir = await path.dirname(filepath);

    // Get the relative part after the input folder
    const relativePart = dir.split(this._inputFolder)[1];

    if (relativePart) {
      // Normalize path separators
      return relativePart.replace(/\\/g, '/');
    }

    // Fallback to full directory if input folder not found
    return dir;
  }

  // ==========================================
  // Group Queries
  // ==========================================

  get numberOfGroups(): number {
    return this._groupedFrames.size;
  }

  getNumberOfFramesInGroup(group: string): number {
    return this._groupedFrames.get(group)?.length ?? 0;
  }

  get activeGroupLength(): number {
    return this._groupedFrames.get(this._activeGroup)?.length ?? 0;
  }

  /**
   * Finds the group that contains the given filepath.
   * @returns The group name, or null if not found
   */
  async findGroupForFilepath(filepath: string): Promise<string | null> {
    const groupName = await this.extractGroupName(filepath);
    return this._groupedFrames.has(groupName) ? groupName : null;
  }

  /**
   * Gets all frames in a specific group.
   * @returns Array of frame paths, or empty array if group doesn't exist
   */
  getFramesInGroup(group: string): readonly string[] {
    return this._groupedFrames.get(group) ?? [];
  }

  // ==========================================
  // Active Group Management
  // ==========================================

  /**
   * Sets the active group and clears the frame cache.
   */
  setActiveGroup(group: string): void {
    if (this._activeGroup === group) {
      return; // No change needed
    }

    this._activeGroup = group;
    this._loadedFrames.clear();
  }

  /**
   * Sets the active group based on a filepath.
   */
  async setActiveGroupFromFilepath(filepath: string): Promise<void> {
    const group = await this.findGroupForFilepath(filepath);

    if (group) {
      this.setActiveGroup(group);
    }
  }

  // ==========================================
  // Frame Access
  // ==========================================

  /**
   * Gets a frame from the active group by index.
   * Loads and caches the frame if not already loaded.
   * @returns The frame data URL, or null if not found
   */
  async getFrameInActiveGroup(index: number): Promise<string | null> {
    // Return from cache if available
    const cached = this._loadedFrames.get(index);
    if (cached) {
      return cached;
    }

    // Load the frame
    const framePath = this.getFramePathInActiveGroup(index);
    if (!framePath) {
      return null;
    }

    try {
      const frameData = await loadImageFile(framePath);
      this._loadedFrames.set(index, frameData);
      return frameData;
    } catch (error) {
      console.error(`Failed to load frame at index ${index}:`, error);
      return null;
    }
  }

  /**
   * Gets the file path of a frame in the active group.
   * @returns The frame path, or null if index is out of bounds
   */
  getFramePathInActiveGroup(index: number): string | null {
    const frames = this._groupedFrames.get(this._activeGroup);

    if (!frames || index < 0 || index >= frames.length) {
      return null;
    }

    return frames[index];
  }

  /**
   * Alias for getFramePathInActiveGroup for backward compatibility.
   * @deprecated Use getFramePathInActiveGroup instead
   */
  getFrameNameInActiveGroup(index: number): string | null {
    return this.getFramePathInActiveGroup(index);
  }

  /**
   * Pre-loads all frames in the active group into cache.
   * Useful for smoother navigation through frames.
   */
  async cacheActiveGroupFrames(): Promise<void> {
    const frames = this._groupedFrames.get(this._activeGroup);

    if (!frames) {
      return;
    }

    const loadPromises = frames.map(async (framePath, index) => {
      // Skip already cached frames
      if (this._loadedFrames.has(index)) {
        return;
      }

      try {
        const frameData = await loadImageFile(framePath);
        this._loadedFrames.set(index, frameData);
      } catch (error) {
        console.error(`Failed to cache frame ${index}:`, error);
      }
    });

    await Promise.all(loadPromises);
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  /**
   * Clears all data and resets the service.
   */
  reset(): void {
    this._groupedFrames.clear();
    this._loadedFrames.clear();
    this._activeGroup = '';
    this._inputFolder = '';
  }

  /**
   * Checks if a group exists.
   */
  hasGroup(group: string): boolean {
    return this._groupedFrames.has(group);
  }

  /**
   * Gets all group names.
   */
  getAllGroupNames(): string[] {
    return Array.from(this._groupedFrames.keys());
  }

  /**
   * Finds the index of a filepath within its group.
   * @returns The index, or -1 if not found
   */
  findFrameIndexInGroup(group: string, filepath: string): number {
    const frames = this._groupedFrames.get(group);
    return frames?.indexOf(filepath) ?? -1;
  }

  /**
   * Finds the index of a filepath within the active group.
   * @returns The index, or -1 if not found
   */
  findFrameIndexInActiveGroup(filepath: string): number {
    return this.findFrameIndexInGroup(this._activeGroup, filepath);
  }
}