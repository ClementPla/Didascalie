import { Injectable, signal } from '@angular/core';
import { check, Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

/**
 * Desktop auto-update against the app's GitHub releases (via the Tauri updater
 * plugin). The launcher checks once on load and offers the update if one is
 * available. No-ops outside the Tauri runtime (e.g. `ng serve` in a browser).
 */
@Injectable({ providedIn: 'root' })
export class UpdateService {
  private readonly _available = signal<Update | null>(null);
  /** The pending update, or null when none / not yet checked. */
  readonly available = this._available.asReadonly();
  readonly checking = signal(false);
  readonly installing = signal(false);
  /** Download progress 0..100 while installing. */
  readonly progress = signal(0);

  private get inTauri(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  get newVersion(): string | null {
    return this._available()?.version ?? null;
  }

  /** Query the release channel once. Safe to call anywhere — silent no-op in a
   *  plain browser, and errors (offline, etc.) are swallowed. */
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

  /** Download + install the pending update, then relaunch into the new version. */
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

  /** Dismiss the offer for this session. */
  dismiss(): void {
    this._available.set(null);
  }
}
