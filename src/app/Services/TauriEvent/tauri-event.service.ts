// tauri-event.service.ts
import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { TauriEventBase } from './tauri-event-base';
import { DownloadProgress } from './interface';


@Injectable({
  providedIn: 'root'
})
export class TauriEventService extends TauriEventBase {
  private initialized = false;

  private downloadProgressSubject = new Subject<DownloadProgress>();
  private segmentationStartedSubject = new Subject<void>();
  private segmentationCompletedSubject = new Subject<void>();

  public downloadProgress$ = this.downloadProgressSubject.asObservable();
  public segmentationStarted$ = this.segmentationStartedSubject.asObservable();
  public segmentationCompleted$ = this.segmentationCompletedSubject.asObservable();

  constructor(ngZone: NgZone) {
    super(ngZone);
  }

  /**
   * Initialize all Tauri event listeners.
   * Call this once from the root component or app initializer.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      console.warn('TauriEventService already initialized');
      return;
    }

    try {
      await this.registerListener<DownloadProgress>(
        'download-progress',
        (progress) => {
          this.downloadProgressSubject.next(progress);
        }
      );

      await this.registerListener<void>(
        'mask-segmentation-started',
        () => {
          this.segmentationStartedSubject.next();
        }
      );

      await this.registerListener<void>(
        'mask-segmentation-completed',
        () => {
          this.segmentationCompletedSubject.next();
        }
      );

      this.initialized = true;
      console.log('TauriEventService initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Tauri event listeners:', error);
      throw error;
    }
  }

  public isInitialized(): boolean {
    return this.initialized;
  }

  override ngOnDestroy(): void {
    this.downloadProgressSubject.complete();
    this.segmentationStartedSubject.complete();
    this.segmentationCompletedSubject.complete();
    super.ngOnDestroy();
  }
}