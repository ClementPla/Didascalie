import { Injectable } from '@angular/core';
import { Subject, takeUntil } from 'rxjs';
import { invoke } from '@tauri-apps/api/core';

import { CLIService } from './TauriEvent/cli.service';
import { TauriEventService } from './TauriEvent/tauri-event.service';
import { ProjectService } from './ProjectService/project.service';
import { SequenceService } from './sequence.service';
import { IOService } from './io.service';
import {ProjectConfig} from '../lib/api';
import { ImageFromCLI } from './TauriEvent';

@Injectable({
  providedIn: 'root',
})
export class AppInitializationService {
  private destroy$ = new Subject<void>();

  constructor(
    private cliService: CLIService,
    private tauriEventService: TauriEventService,
    private projectService: ProjectService,
    private sequenceService: SequenceService,
    private ioService: IOService
  ) {}

  /**
   * Initialize all Tauri event services and set up application-level event handling.
   * Should be called once during app bootstrap.
   */
  async initialize(): Promise<void> {
    try {
      // Initialize Tauri backend event listeners
      await this.tauriEventService.initialize();

      // Set up CLI command handlers
      this.setupCLIHandlers();

      console.log('Application initialized successfully');
    } catch (error) {
      console.error('Failed to initialize application:', error);
      throw error;
    }
  }

  /**
   * Set up handlers for CLI commands received from Tauri backend.
   */
  private setupCLIHandlers(): void {
    this.cliService.projectCreated$
      .pipe(takeUntil(this.destroy$))
      .subscribe((config) => this.handleProjectCreation(config));

    this.cliService.imageLoaded$
      .pipe(takeUntil(this.destroy$))
      .subscribe((imageConfig) => this.handleImageLoad(imageConfig));
  }

  /**
   * Handle project creation from CLI.
   */
  private async handleProjectCreation(config: ProjectConfig): Promise<void> {
    try {
      // Update project service config
      this.projectService.updateConfig(config);

      // Determine project file path
      const projectPath = config.input_folder
        ? `${config.input_folder}/${config.name}.dida`
        : `${config.name}.dida`;

      // Create project
      await this.projectService.create(projectPath);

      // Scan and import images
      await this.projectService.scanFolder();

      // Load sequences
      await this.sequenceService.loadSequences();

      console.log('Project created from CLI:', config.name);
    } catch (error) {
      console.error('Failed to create project from CLI:', error);
    }
  }

  /**
   * Handle image load from CLI (for annotation via ZMQ).
   */
  private async handleImageLoad(imageConfig: ImageFromCLI): Promise<void> {
    try {
      const frameId = await this.findFrameByPath(imageConfig.image_path);

      if (frameId === null) {
        console.error('Frame not found in database:', imageConfig.image_path);
        return;
      }

      // If mask data is provided, save it
      if (imageConfig.mask_data && imageConfig.mask_data.length > 0) {
        await this.saveMasksFromCLI(frameId, imageConfig);
      }

      console.log('Image loaded from CLI:', imageConfig.image_path);
    } catch (error) {
      console.error('Failed to load image from CLI:', error);
    }
  }

  /**
   * Find frame by path.
   */
  private async findFrameByPath(imagePath: string): Promise<number | null> {
    try {
      return await invoke<number | null>('find_frame_by_path', {
        relativePath: imagePath,
      });
    } catch (error) {
      console.error('Error finding frame:', error);
      return null;
    }
  }

  /**
   * Save masks received from CLI to database.
   */
  private async saveMasksFromCLI(frameId: number, imageConfig: ImageFromCLI): Promise<void> {
    if (!imageConfig.mask_data) return;

    const labels = await invoke<Array<{ id: number; name: string }>>('list_labels');

    for (let i = 0; i < imageConfig.mask_data.length; i++) {
      const maskDataUrl = imageConfig.mask_data[i];
      const label = labels[i];

      if (!label || !maskDataUrl) continue;

      const maskData = await this.dataUrlToMaskData(maskDataUrl);

      if (maskData) {
        await invoke('save_annotation', {
          frameId,
          annotation: {
            label_id: label.id,
            mask_data: Array.from(maskData),
            width: imageConfig.width,
            height: imageConfig.height,
          },
        });
      }
    }
  }

  /**
   * Convert base64 data URL to raw mask data (alpha channel).
   */
  private async dataUrlToMaskData(dataUrl: string): Promise<Uint8Array | null> {
    try {
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const bitmap = await createImageBitmap(blob);

      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);

      const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      const mask = new Uint8Array(bitmap.width * bitmap.height);

      for (let i = 0; i < mask.length; i++) {
        mask[i] = imageData.data[i * 4 + 3];
      }

      return mask;
    } catch (error) {
      console.error('Failed to convert data URL to mask:', error);
      return null;
    }
  }

  async cleanup(): Promise<void> {
    this.destroy$.next();
    this.destroy$.complete();
    await invoke('close_project');
  }
}