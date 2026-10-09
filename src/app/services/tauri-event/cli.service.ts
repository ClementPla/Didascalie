import { Injectable, NgZone, inject } from '@angular/core';
import { Subject } from 'rxjs';
import { ImageFromCLI } from './interface'
import { TauriEventBase } from './tauri-event-base';
import { ProjectConfig } from '../../lib/api';

@Injectable({
  providedIn: 'root',
})
export class CLIService extends TauriEventBase {
  public projectCreated$ = new Subject<ProjectConfig>();
  public imageLoaded$ = new Subject<ImageFromCLI>();

  constructor() {
    const ngZone = inject(NgZone);

    super(ngZone);
    this.initializeListeners();
  }

  private async initializeListeners(): Promise<void> {
    await this.registerListenerWithAck<ProjectConfig>(
      'create_project',
      (config) => {
        this.projectCreated$.next(config);
      }
    );

    await this.registerListenerWithAck<ImageFromCLI>(
      'load_image',
      (image) => {
        this.imageLoaded$.next(image);
      }
    );
  }

  override ngOnDestroy(): void {
    this.projectCreated$.complete();
    this.imageLoaded$.complete();
    super.ngOnDestroy();
  }
}