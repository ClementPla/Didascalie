// app-initialization.service.ts
import { Injectable } from '@angular/core';
import { CLIService } from './TauriEvent/cli.service';
import { TauriEventService } from './TauriEvent/tauri-event.service';
import { ProjectService } from './ProjectService/project.service';
import { IOService } from './io.service';
import { ImageFromCLI, ProjectConfig } from './TauriEvent/interface';
import { Subject, takeUntil } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class AppInitializationService {
  private destroy$ = new Subject<void>();

  constructor(
    private cliService: CLIService,
    private tauriEventService: TauriEventService,
    private projectService: ProjectService,
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
   * These commands come through ZMQ.REP socket → Tauri events → Angular services.
   */
  private setupCLIHandlers(): void {
    this.cliService.projectCreated$
      .pipe(takeUntil(this.destroy$))
      .subscribe((config) => this.handleProjectCreation(config));

    this.cliService.imageLoaded$
      .pipe(takeUntil(this.destroy$))
      .subscribe((imageConfig) => this.handleImageLoad(imageConfig));
  }

  private handleProjectCreation(config: ProjectConfig): void {
    this.projectService.createProjectFromCLI(config);
  }

  private async handleImageLoad(imageConfig: ImageFromCLI): Promise<void> {
    try {
      await this.ioService.loadImageFromCLI(imageConfig);
    } catch (error) {
      console.error('Failed to load image from CLI:', error);
      // TODO: Emit error event for notification system
    }
  }

  cleanup(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}