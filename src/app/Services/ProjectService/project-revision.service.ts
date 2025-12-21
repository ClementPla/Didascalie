import { Injectable } from '@angular/core';
import { path } from '@tauri-apps/api';
import { invokeLoadJsonFile, invokeSaveJsonFile } from '../../Core/save_load';

const REVISIONS_FILENAME = '.revisions.json';

interface RevisionsData {
  images: string[];
}

/**
 * Tracks which images have been opened/reviewed in a project.
 * Persists the list to a JSON file in the project folder.
 */
@Injectable({
  providedIn: 'root',
})
export class ProjectRevisionService {
  private _openedImages: Set<string> = new Set();
  private _projectFolder: string = '';

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Gets the list of opened images.
   */
  get openedImages(): readonly string[] {
    return Array.from(this._openedImages);
  }

  /**
   * Checks if an image has been opened.
   */
  hasBeenOpened(imageName: string): boolean {
    return this._openedImages.has(imageName);
  }

  /**
   * Gets the count of opened images.
   */
  get openedCount(): number {
    return this._openedImages.size;
  }

  /**
   * Initializes the service for a project folder.
   * Loads existing revisions from disk.
   */
  async initialize(projectFolder: string): Promise<void> {
    this._projectFolder = projectFolder;
    this._openedImages.clear();
    await this.loadRevisions();
  }

  /**
   * Marks an image as opened and persists to disk.
   */
  async markAsOpened(imageName: string): Promise<void> {
    if (!imageName || this._openedImages.has(imageName)) {
      return;
    }

    this._openedImages.add(imageName);
    await this.saveRevisions();
  }

  /**
   * Marks multiple images as opened and persists to disk.
   */
  async markMultipleAsOpened(imageNames: string[]): Promise<void> {
    let hasChanges = false;

    for (const name of imageNames) {
      if (name && !this._openedImages.has(name)) {
        this._openedImages.add(name);
        hasChanges = true;
      }
    }

    if (hasChanges) {
      await this.saveRevisions();
    }
  }

  /**
   * Resets the service state.
   */
  reset(): void {
    this._openedImages.clear();
    this._projectFolder = '';
  }

  /**
   * Gets progress information.
   */
  getProgress(totalImages: number): { opened: number; total: number; percentage: number } {
    const opened = this._openedImages.size;
    return {
      opened,
      total: totalImages,
      percentage: totalImages > 0 ? Math.round((opened / totalImages) * 100) : 0,
    };
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private async getRevisionsPath(): Promise<string> {
    return path.join(this._projectFolder, REVISIONS_FILENAME);
  }

  private async loadRevisions(): Promise<void> {
    if (!this._projectFolder) {
      return;
    }

    try {
      const revisionPath = await this.getRevisionsPath();
      const rawData = await invokeLoadJsonFile(revisionPath);

      if (rawData) {
        const data = typeof rawData === 'string' ? JSON.parse(rawData) as RevisionsData : rawData as RevisionsData;
        
        if (Array.isArray(data.images)) {
          data.images.forEach((image) => {
            if (typeof image === 'string') {
              this._openedImages.add(image);
            }
          });
        }
      }
    } catch (error) {
      // File may not exist yet, which is expected for new projects
      console.debug('No existing revisions found (this is normal for new projects)');
    }
  }

  private async saveRevisions(): Promise<void> {
    if (!this._projectFolder) {
      console.warn('Cannot save revisions: no project folder set');
      return;
    }

    try {
      const revisionPath = await this.getRevisionsPath();
      const data: RevisionsData = {
        images: Array.from(this._openedImages),
      };
      
      await invokeSaveJsonFile(revisionPath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save revisions:', error);
    }
  }
}