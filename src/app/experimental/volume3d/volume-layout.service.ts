import { Injectable, computed, signal } from '@angular/core';

export type VolumeViewId = '3d' | 'projection';

/**
 * Where a view is shown:
 * - `docked`: in the panel beside the editor canvas;
 * - `maximized`: over the whole editor area (the canvas column);
 * - `detached`: in its own OS window.
 */
export type VolumeViewMode = 'docked' | 'maximized' | 'detached';

/**
 * Layout of 3D mode's views. The panel component applies it (moving DOM for
 * detached views); the views' headers change it.
 */
@Injectable({ providedIn: 'root' })
export class VolumeLayoutService {
  readonly modes = signal<Record<VolumeViewId, VolumeViewMode>>({ '3d': 'docked', projection: 'docked' });
  /** The panel is folded to a thin rail beside the canvas. */
  readonly panelCollapsed = signal(false);

  readonly maximized = computed(() => {
    const modes = this.modes();
    return (Object.keys(modes) as VolumeViewId[]).find((id) => modes[id] === 'maximized') ?? null;
  });

  mode(id: VolumeViewId): VolumeViewMode {
    return this.modes()[id];
  }

  set(id: VolumeViewId, mode: VolumeViewMode): void {
    this.modes.update((modes) => {
      const next = { ...modes, [id]: mode };
      // One view covers the editor at a time.
      if (mode === 'maximized') {
        for (const other of Object.keys(next) as VolumeViewId[]) {
          if (other !== id && next[other] === 'maximized') next[other] = 'docked';
        }
      }
      return next;
    });
  }

  toggleMaximized(id: VolumeViewId): void {
    this.set(id, this.mode(id) === 'maximized' ? 'docked' : 'maximized');
  }

  toggleDetached(id: VolumeViewId): void {
    this.set(id, this.mode(id) === 'detached' ? 'docked' : 'detached');
  }

  /** Back to the defaults (3D mode turned off). */
  reset(): void {
    this.modes.set({ '3d': 'docked', projection: 'docked' });
  }
}
