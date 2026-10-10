import { Injectable, signal } from '@angular/core';
import { getVersion } from '@tauri-apps/api/app';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/** Desktop auto-update from the app's GitHub releases (Tauri updater
 *  plugin). Does nothing outside the Tauri runtime. */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly _available = signal<Update | null>(null);
  /** The pending update, or null. */
  readonly available = this._available.asReadonly();
  readonly checking = signal(false);
  readonly installing = signal(false);
  /** Download progress 0..100 while installing. */
  readonly progress = signal(0);
  /** The running app version, or null in a plain browser. */
  readonly currentVersion = signal<string | null>(null);

  constructor() {
    void this.loadCurrentVersion();
  }

  private get inTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  private async loadCurrentVersion(): Promise<void> {
    if (!this.inTauri) return;
    try {
      this.currentVersion.set(await getVersion());
    } catch (error) {
      console.error('Failed to read app version:', error);
    }
  }

  get newVersion(): string | null {
    return this._available()?.version ?? null;
  }

  /** Query the release channel. Errors (offline…) are swallowed. */
  async checkForUpdates(): Promise<void> {
    if (!this.inTauri || this.checking()) return;
    this.checking.set(true);
    try {
      const update = await check();
      this._available.set(update?.available ? update : null);
    } catch (error) {
      console.error('Update check failed:', error);
    } finally {
      this.checking.set(false);
    }
  }

  /** Download and install the pending update, then relaunch. */
  async installAndRestart(): Promise<void> {
    const update = this._available();
    if (!update || this.installing()) return;
    this.installing.set(true);
    this.progress.set(0);
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            total = event.data.contentLength ?? 0;
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            if (total > 0) this.progress.set(Math.round((downloaded / total) * 100));
            break;
          case 'Finished':
            this.progress.set(100);
            break;
        }
      });
      await relaunch();
    } catch (error) {
      console.error('Update install failed:', error);
      this.installing.set(false);
    }
  }

  dismiss(): void {
    this._available.set(null);
  }
}
