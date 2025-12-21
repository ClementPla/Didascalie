// tauri-event.service.ts
import { Injectable, OnDestroy, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

export interface DownloadProgress {
  downloaded: boolean;
  progress: number;
}

@Injectable({
  providedIn: 'root'
})
export class TauriEventService implements OnDestroy {
  private unlistenFunctions: UnlistenFn[] = [];
  private initialized = false;

  // Event streams
  private downloadProgressSubject = new Subject<DownloadProgress>();
  private segmentationStartedSubject = new Subject<void>();
  private segmentationCompletedSubject = new Subject<void>();

  public downloadProgress$ = this.downloadProgressSubject.asObservable();
  public segmentationStarted$ = this.segmentationStartedSubject.asObservable();
  public segmentationCompleted$ = this.segmentationCompletedSubject.asObservable();

  constructor(private ngZone: NgZone) {}

  /**
   * Initialize all Tauri event listeners.
   * Call this once from the root component or app initializer.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const downloadUnlisten = await listen<DownloadProgress>('download-progress', (event) => {
        this.ngZone.run(() => {
          this.downloadProgressSubject.next(event.payload);
        });
      });
      this.unlistenFunctions.push(downloadUnlisten);

      const segStartUnlisten = await listen<void>('mask-segmentation-started', () => {
        this.ngZone.run(() => {
          this.segmentationStartedSubject.next();
        });
      });
      this.unlistenFunctions.push(segStartUnlisten);

      const segCompleteUnlisten = await listen<void>('mask-segmentation-completed', () => {
        this.ngZone.run(() => {
          this.segmentationCompletedSubject.next();
        });
      });
      this.unlistenFunctions.push(segCompleteUnlisten);

      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize Tauri event listeners:', error);
    }
  }

  ngOnDestroy() {
    this.unlistenFunctions.forEach(unlisten => unlisten());
    this.unlistenFunctions = [];
    this.downloadProgressSubject.complete();
    this.segmentationStartedSubject.complete();
    this.segmentationCompletedSubject.complete();
  }
}