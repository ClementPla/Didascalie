/**
 * IO Service integration for PixiJS canvas
 * Handles saving/loading layer states to/from SVG format
 */

import { Injectable } from '@angular/core';
import { path } from '@tauri-apps/api';
import { invoke } from '@tauri-apps/api/core';
import { PixiCanvasComponent } from './pixi-canvas.component';
import { LabelsService } from '../../../../Services/Labels/labels.service';
import { ProjectService } from '../../../../Services/ProjectService/project.service';

@Injectable({
  providedIn: 'root',
})
export class PixiIOService {
  constructor(
    private labelsService: LabelsService,
    private projectService: ProjectService
  ) {}

  /**
   * Save all layers to SVG format
   * Matches your existing annotation format
   */
  async save(canvas: PixiCanvasComponent): Promise<boolean> {
    if (!this.projectService.activeImage) {
      console.warn('No active image to save');
      return false;
    }

    try {
      // Get all layer states
      const layerStates = canvas.getAllLayerStates();

      // Build SVG document
      const width = Array.from(layerStates.values())[0]?.width || 0;
      const height = Array.from(layerStates.values())[0]?.height || 0;

      const svgPaths: string[] = [];

      // Convert each layer to SVG path
      layerStates.forEach((imageData, layerId) => {
        const adapter = canvas.getServiceAdapter();
        const { labelIndex, instanceIndex } = adapter.parseLayerId(layerId);
        const label = this.labelsService.listSegmentationLabels[labelIndex];

        if (!label) return;

        // Get color for this layer
        let color = label.color;
        if (instanceIndex !== undefined && label.shades) {
          color = label.shades[instanceIndex];
        }

        // Convert ImageData to SVG path using contours
        const paths = this.imageDataToSVGPaths(imageData, color, label.label);
        svgPaths.push(...paths);
      });

      // Build complete SVG
      const svg = this.buildSVG(width, height, svgPaths);

      // Save to file
      const filename = this.getAnnotationFilename(
        this.projectService.activeImage!
      );
      const filepath = await path.join(
        this.projectService.projectFolder,
        'annotations',
        'local',
        filename
      );

      await this.saveSVGFile(filepath, svg);

      return true;
    } catch (error) {
      console.error('Error saving annotations:', error);
      return false;
    }
  }

  /**
   * Load layers from SVG format
   */
  async load(canvas: PixiCanvasComponent): Promise<void> {
    if (!this.projectService.activeImage) {
      console.warn('No active image to load');
      return;
    }

    try {
      const filename = this.getAnnotationFilename(
        this.projectService.activeImage!
      );
      const filepath = await path.join(
        this.projectService.projectFolder,
        'annotations',
        'local',
        filename
      );

      // Check if file exists
      const exists = await this.fileExists(filepath);
      if (!exists) {
        console.log('No existing annotations for this image');
        return;
      }

      // Load SVG content
      const svgContent = await this.loadSVGFile(filepath);

      // Parse SVG and extract paths by label/color
      const pathsByLabel = this.parseSVGPaths(svgContent);

      // Get image dimensions
      const backgroundSprite = (canvas as any).backgroundSprite;
      const width = backgroundSprite.width;
      const height = backgroundSprite.height;

      // Convert paths back to ImageData for each layer
      const layerStates = new Map<string, ImageData>();

      pathsByLabel.forEach((labelInfo) => {
        const imageData = this.svgPathsToImageData(
          labelInfo.paths,
          width,
          height,
          labelInfo.color
        );
        layerStates.set(labelInfo.layerId, imageData);
      });

      // Restore to canvas
      canvas.setAllLayerStates(layerStates);
    } catch (error) {
      console.error('Error loading annotations:', error);
      throw error;
    }
  }

  /**
   * Convert ImageData to SVG paths using contour tracing
   */
  private imageDataToSVGPaths(
    imageData: ImageData,
    color: string,
    label: string
  ): string[] {
    // Create temporary canvas for contour detection
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(imageData, 0, 0);

    // Find contours (simplified - you might want to use your OpenCV service here)
    const contours = this.findContours(imageData);

    // Convert contours to SVG paths
    const paths = contours.map((contour) => {
      const pathData = this.contourToPathData(contour);
      return `<path d="${pathData}" fill="${color}" stroke="${color}" stroke-width="1" data-label="${label}" />`;
    });

    return paths;
  }

  /**
   * Simple contour finding (marching squares algorithm)
   * For production, use your OpenCV service
   */
  private findContours(imageData: ImageData): { x: number; y: number }[][] {
    const contours: { x: number; y: number }[][] = [];
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;
    const visited = new Set<string>();

    // Find all connected components
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const alpha = data[idx + 3];

        if (alpha > 127 && !visited.has(`${x},${y}`)) {
          const contour = this.traceContour(imageData, x, y, visited);
          if (contour.length > 2) {
            contours.push(contour);
          }
        }
      }
    }

    return contours;
  }

  /**
   * Trace contour starting from a point
   */
  private traceContour(
    imageData: ImageData,
    startX: number,
    startY: number,
    visited: Set<string>
  ): { x: number; y: number }[] {
    const contour: { x: number; y: number }[] = [];
    const queue: { x: number; y: number }[] = [{ x: startX, y: startY }];
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    while (queue.length > 0) {
      const point = queue.shift()!;
      const key = `${point.x},${point.y}`;

      if (visited.has(key)) continue;
      visited.add(key);

      const idx = (point.y * width + point.x) * 4;
      const alpha = data[idx + 3];

      if (alpha > 127) {
        contour.push(point);

        // Check 8-connected neighbors
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = point.x + dx;
            const ny = point.y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              queue.push({ x: nx, y: ny });
            }
          }
        }
      }
    }

    return contour;
  }

  /**
   * Convert contour points to SVG path data
   */
  private contourToPathData(contour: { x: number; y: number }[]): string {
    if (contour.length === 0) return '';

    let pathData = `M ${contour[0].x} ${contour[0].y}`;
    for (let i = 1; i < contour.length; i++) {
      pathData += ` L ${contour[i].x} ${contour[i].y}`;
    }
    pathData += ' Z'; // Close path

    return pathData;
  }

  /**
   * Build complete SVG document
   */
  private buildSVG(width: number, height: number, paths: string[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${paths.join('\n')}
</svg>`;
  }

  /**
   * Parse SVG content and extract paths by label
   */
  private parseSVGPaths(
    svgContent: string
  ): Map<string, { paths: string[]; color: string; layerId: string }> {
    const parser = new DOMParser();
    const doc = parser.parseFromString(svgContent, 'image/svg+xml');
    const pathElements = doc.querySelectorAll('path');

    const pathsByLabel = new Map<
      string,
      { paths: string[]; color: string; layerId: string }
    >();

    pathElements.forEach((pathEl) => {
      const label = pathEl.getAttribute('data-label') || '';
      const color = pathEl.getAttribute('fill') || '#ffffff';
      const pathData = pathEl.getAttribute('d') || '';

      // Find label index
      const labelIndex = this.labelsService.listSegmentationLabels.findIndex(
        (l) => l.label === label
      );

      if (labelIndex < 0) return;

      // Determine layer ID (handle instance segmentation)
      let layerId = `label_${labelIndex}`;
      if (this.projectService.isInstanceSegmentation) {
        const segLabel = this.labelsService.listSegmentationLabels[labelIndex];
        if (segLabel.shades) {
          const instanceIndex = segLabel.shades.indexOf(color);
          if (instanceIndex >= 0) {
            layerId = `label_${labelIndex}_inst_${instanceIndex}`;
          }
        }
      }

      const key = `${label}_${color}`;
      if (!pathsByLabel.has(key)) {
        pathsByLabel.set(key, { paths: [], color, layerId });
      }

      pathsByLabel.get(key)!.paths.push(pathData);
    });

    return pathsByLabel;
  }

  /**
   * Convert SVG paths back to ImageData
   */
  private svgPathsToImageData(
    paths: string[],
    width: number,
    height: number,
    color: string
  ): ImageData {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;

    ctx.fillStyle = color;
    ctx.strokeStyle = color;

    paths.forEach((pathData) => {
      const path = new Path2D(pathData);
      ctx.fill(path);
    });

    return ctx.getImageData(0, 0, width, height);
  }

  /**
   * Get annotation filename from image filename
   */
  private getAnnotationFilename(imagePath: string): string {
    // Extract filename without extension
    const parts = imagePath.split(/[\\/]/);
    const filename = parts[parts.length - 1];
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    return `${nameWithoutExt}.svg`;
  }

  /**
   * Save SVG content to file using Tauri
   */
  private async saveSVGFile(filepath: string, content: string): Promise<void> {
    await invoke('save_text_file', {
      filepath,
      content,
    });
  }

  /**
   * Load SVG content from file using Tauri
   */
  private async loadSVGFile(filepath: string): Promise<string> {
    return await invoke<string>('load_text_file', {
      filepath,
    });
  }

  /**
   * Check if file exists using Tauri
   */
  private async fileExists(filepath: string): Promise<boolean> {
    try {
      await invoke('file_exists', { filepath });
      return true;
    } catch {
      return false;
    }
  }
}
