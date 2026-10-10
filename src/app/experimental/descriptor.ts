import { Injector, Type } from '@angular/core';
import { PostProcessOption } from '../core/tools';

export type ExperimentalFeature = 'superpixel' | 'medsam' | 'volume3d';

/** A post-processing mode contributed by an experimental feature. */
export interface ExperimentalPostProcess {
  option: PostProcessOption;
  /** Helper text shown under the mode selector in the tool settings panel. */
  description: string;
  /** Settings UI shown while the mode is selected. */
  settingsComponent?: Type<unknown>;
  /** Apply the post-process to the current stroke. */
  run(injector: Injector): Promise<void>;
}

/**
 * What an experimental feature exposes to the rest of the app. Core code
 * reads these through the registry and never imports a feature directly.
 */
export interface ExperimentalFeatureDescriptor {
  flag: ExperimentalFeature;
  label: string;
  description: string;
  postProcess?: ExperimentalPostProcess[];
  /** A new image was loaded in the editor. */
  onImageLoaded?(injector: Injector): void;
  /** Overlay to composite on the canvas, or null. */
  getOverlay?(injector: Injector): CanvasImageSource | null;
  /** Panes shown beside the editor canvas. */
  editorPanes?: Type<unknown>[];
  /** Overlays stacked over the canvas viewport, above the label layer.
   *  `pointer-events: none` by default. */
  canvasOverlays?: Type<unknown>[];
  /** Experimental features were switched off: hide any visible state. */
  onDisabled?(injector: Injector): void;
}
