import { Injector, Type } from '@angular/core';
import { PostProcessOption } from '../core/tools';

/** Identifier of an experimental feature. Extend this union when adding one. */
export type ExperimentalFeature = 'superpixel' | 'volume3d';

/** A post-processing mode contributed by an experimental feature. */
export interface ExperimentalPostProcess {
  option: PostProcessOption;
  /** Helper text shown under the mode selector in the tool settings panel. */
  description: string;
  /** Optional settings UI rendered below the description while the mode is
   *  selected (via ngComponentOutlet, so core code never imports it). */
  settingsComponent?: Type<unknown>;
  /** Apply the post-process to the current stroke. Services are resolved
   *  through the injector so core services never import experimental code. */
  run(injector: Injector): Promise<void>;
}

/**
 * Everything an experimental feature exposes to the rest of the app.
 * Core code only consumes these descriptors through the registry helpers —
 * it never imports a feature's services or components directly.
 */
export interface ExperimentalFeatureDescriptor {
  flag: ExperimentalFeature;
  /** Human-readable name, listed in the experimental-features popover. */
  label: string;
  /** One-line summary, shown next to the label in the popover. */
  description: string;
  /** Post-process modes this feature adds to the Processing panel. */
  postProcess?: ExperimentalPostProcess[];
  /** Called whenever a new image is loaded in the editor (invalidate caches). */
  onImageLoaded?(injector: Injector): void;
  /** Image-native overlay to composite on the canvas overlay layer, or null
   *  when the feature has nothing to show right now. */
  getOverlay?(injector: Injector): CanvasImageSource | null;
  /** Panes shown beside the editor canvas (via ngComponentOutlet, so core code
   *  never imports them). Each pane hides itself while it has nothing to show. */
  editorPanes?: Type<unknown>[];
  /** Overlays stacked over the editor canvas's viewport, above the label
   *  layer (via ngComponentOutlet). Each is `pointer-events: none` by default
   *  and owns which parts of it take input. */
  canvasOverlays?: Type<unknown>[];
  /** Called when experimental features are switched off: hide any visible
   *  state. (An experimental post-process mode that is still selected is
   *  reset generically by the FeatureFlagsService.) */
  onDisabled?(injector: Injector): void;
}
