import { Injectable, effect, signal } from '@angular/core';

export type MeshDetail = 'auto' | 1 | 2 | 4;
export type VolumeRenderMode = 'mip' | 'composite';
/** How the projection reduces each segment; `depth` shows only the point at
 *  `projectionDepth` (the curved surface a projection stroke writes to). */
export type ProjectionReduce = 'max' | 'mean' | 'min' | 'depth';

/** Display settings of the 3D view. User preferences, not project data. */
export interface Volume3dSettings {
  /** Distance between slices, in pixels (1 = cubic voxels). */
  zSpacing: number;
  /** Mesh level of detail: grid voxel = `lod³` voxels. */
  detail: MeshDetail;

  showSurface: boolean;
  surfaceOpacity: number;
  /** The exact label voxels as blocks, over the smooth surface. */
  showBlocks: boolean;
  blocksOpacity: number;

  /** Three orthogonal image planes: the current slice plus a sagittal and a
   *  coronal plane at `planeX` / `planeY` (fractions of the width / height). */
  showPlanes: boolean;
  planesOpacity: number;
  planeX: number;
  planeY: number;

  /** Direct volume rendering of the image. */
  showVolume: boolean;
  volumeOpacity: number;
  volumeMode: VolumeRenderMode;
  /** Intensity window, 0..255 (shared by every image display). */
  windowLow: number;
  windowHigh: number;

  /** How the projection reduces the image along each segment. */
  projectionMode: ProjectionReduce;
  projectionLabels: boolean;
  projectionLabelOpacity: number;
  /** Where along each segment strokes are written (0 = on A, 1 = on B). */
  projectionDepth: number;

  /** Panel layout: which views are expanded, and the 3D view's share of the
   *  height when both are. */
  show3d: boolean;
  showProjection: boolean;
  split: number;
}

const DEFAULTS: Volume3dSettings = {
  zSpacing: 1,
  detail: 'auto',
  showSurface: true,
  surfaceOpacity: 1,
  showBlocks: false,
  blocksOpacity: 0.35,
  showPlanes: true,
  planesOpacity: 1,
  planeX: 0.5,
  planeY: 0.5,
  showVolume: false,
  volumeOpacity: 0.5,
  volumeMode: 'mip',
  windowLow: 0,
  windowHigh: 255,
  projectionMode: 'max',
  projectionLabels: true,
  projectionLabelOpacity: 0.45,
  projectionDepth: 0.5,
  show3d: true,
  showProjection: true,
  split: 0.6,
};

const STORAGE_KEY = 'didascalie.volume3d.settings';

/** Full-resolution voxel count above which `auto` detail halves the grid. */
const AUTO_MAX_VOXELS = 32_000_000;

@Injectable({ providedIn: 'root' })
export class Volume3dSettingsService {
  readonly settings = signal<Volume3dSettings>(load());

  constructor() {
    effect(() => {
      const value = this.settings();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
      } catch {
        // Storage unavailable: settings just don't persist.
      }
    });
  }

  update(patch: Partial<Volume3dSettings>): void {
    this.settings.update((s) => ({ ...s, ...patch }));
  }

  reset(): void {
    this.settings.set({ ...DEFAULTS });
  }

  /** The level of detail to mesh a `w×h×d` volume at. */
  resolveLod(w: number, h: number, d: number): number {
    const detail = this.settings().detail;
    if (detail !== 'auto') return detail;
    let lod = 1;
    while (lod < 4 && (w * h * d) / lod ** 3 > AUTO_MAX_VOXELS) lod *= 2;
    return lod;
  }
}

function load(): Volume3dSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // Unreadable or unavailable: defaults.
  }
  return { ...DEFAULTS };
}
