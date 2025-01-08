import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { ImageFromCLI, ProjectConfig } from '../Core/interface';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

interface EventPayload<T> {
  event_id: string;
  data: T;
}

@Injectable({
  providedIn: 'root',
})
export class CLIService {
  public commandProcessed: Subject<boolean> = new Subject<boolean>();
  public projectCreated = new Subject<ProjectConfig | null>();
  public imageLoaded = new Subject<ImageFromCLI | null>();

  constructor(private ngZone: NgZone) {
    this.initializeListeners();
  }
  private initializeListeners() {
    listen<EventPayload<ProjectConfig>>('create_project', async (event) => {
      try {
        await this.ngZone.run(() => {
          const config = event.payload.data;
          console.log(event);
          this.projectCreated.next(config);
        });
        await invoke('event_processed', {
          id: event.payload.event_id,
          success: true,
        });
        
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';
        await invoke('event_processed', {
          id: event.payload.event_id,
          success: false,
          error: errorMessage,
        });
      }
    });

    listen<EventPayload<ImageFromCLI>>('load_image', async (event) => {
      try {
        await this.ngZone.run(() => {
          const config = event.payload.data;
          this.imageLoaded.next(config);
        });
        await invoke('event_processed', {
          id: event.payload.event_id,
          success: true,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';
        await invoke('event_processed', {
          id: event.payload.event_id,
          success: false,
          error: errorMessage,
        });
      }
    });
  }
}
