// thumbnail.service.ts
import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../Core/save_load';
import { ProjectService } from './ProjectService/project.service';
export interface ThumbnailOptions {
  width: number;
  height: number;
  useCache?: boolean;
}

/**
 * Manages thumbnail generation and caching.
 * 
 * Responsibilities:
 * - Generate thumbnails on-demand or from cache
 * - Coordinate with Rust backend for image processing
 * - Handle both file-based and in-memory thumbnails
 */
@Injectable({
  providedIn: 'root'
})
export class ThumbnailService {
  private static readonly DEFAULT_THUMBNAIL_SIZE = 256;

  constructor(private projectService: ProjectService) {}

  /**
   * Get thumbnail for an image.
   * Uses cache if enabled in project settings, otherwise generates in-memory.
   */
  public async getThumbnail(
    imageName: string,
    options?: Partial<ThumbnailOptions>
  ): Promise<string> {
    const opts = this.getOptions(options);

    const imageInputPath = await path.resolve(
      this.projectService.inputFolder()!,
      imageName
    );

    return await this.getCachedThumbnail(imageName, imageInputPath, opts);
   
  }

  /**
   * Generate or retrieve a cached thumbnail from disk.
   */
  private async getCachedThumbnail(
    imageName: string,
    imageInputPath: string,
    options: ThumbnailOptions
  ): Promise<string> {
    const thumbnailPath = await path.resolve(
      this.projectService.inputFolder()!,
      '.thumbnails',
      imageName
    );

    try {
      // Ask Rust backend to create/update cache
      await invoke('create_cache_thumbnail', {
        imagePath: imageInputPath,
        thumbnailPath: thumbnailPath,
        width: options.width,
        height: options.height,
      });

      // Load the cached file
      return await loadImageFile(thumbnailPath);
    } catch (error) {
      console.error('Failed to create cached thumbnail:', error);
      // Fallback to in-memory generation
      return await this.generateInMemoryThumbnail(imageInputPath, options);
    }
  }

  /**
   * Generate thumbnail in memory (base64).
   */
  private async generateInMemoryThumbnail(
    imageInputPath: string,
    options: ThumbnailOptions
  ): Promise<string> {
    try {
      const base64Data = await invoke<string>('create_thumbnail', {
        imagePath: imageInputPath,
        width: options.width,
        height: options.height,
      });

      return `data:image/png;base64,${base64Data}`;
    } catch (error) {
      console.error('Failed to generate thumbnail:', error);
      throw error;
    }
  }

  /**
   * Merge provided options with defaults.
   */
  private getOptions(options?: Partial<ThumbnailOptions>): ThumbnailOptions {
    return {
      width: options?.width ?? ThumbnailService.DEFAULT_THUMBNAIL_SIZE,
      height: options?.height ?? ThumbnailService.DEFAULT_THUMBNAIL_SIZE,
      useCache: options?.useCache ?? false
    };
  }

  /**
   * Pre-generate thumbnails for multiple images in batch.
   * Useful for gallery initialization.
   */
  public async preGenerateThumbnails(
    imageNames: string[],
    options?: Partial<ThumbnailOptions>
  ): Promise<Map<string, string>> {
    const thumbnails = new Map<string, string>();

    // Generate thumbnails in parallel (consider chunking for large sets)
    const promises = imageNames.map(async (imageName) => {
      try {
        const thumbnail = await this.getThumbnail(imageName, options);
        thumbnails.set(imageName, thumbnail);
      } catch (error) {
        console.error(`Failed to generate thumbnail for ${imageName}:`, error);
      }
    });

    await Promise.all(promises);
    return thumbnails;
  }

  /**
   * Clear thumbnail cache for specific images or all images.
   */
  public async clearCache(imageNames?: string[]): Promise<void> {

  }
}