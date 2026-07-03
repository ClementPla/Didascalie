import { Injector } from '@angular/core';
import { PostProcessOption } from '../Core/tools';
import {
  ExperimentalFeatureDescriptor,
  ExperimentalPostProcess,
} from './descriptor';
import { CRF_FEATURE } from './crf/crf.feature';
import { SUPERPIXEL_FEATURE } from './superpixel/superpixel.feature';

/** All experimental features. Register a new feature by adding it here. */
export const EXPERIMENTAL_FEATURES: ExperimentalFeatureDescriptor[] = [
  CRF_FEATURE,
  SUPERPIXEL_FEATURE,
];

/** Post-process options contributed by experimental features (registry order). */
export function experimentalPostProcessOptions(): PostProcessOption[] {
  return EXPERIMENTAL_FEATURES.flatMap((f) => f.postProcess ?? []).map(
    (p) => p.option
  );
}

export function isExperimentalPostProcess(option: PostProcessOption): boolean {
  return findExperimentalPostProcess(option) !== null;
}

export function findExperimentalPostProcess(
  option: PostProcessOption
): ExperimentalPostProcess | null {
  for (const feature of EXPERIMENTAL_FEATURES) {
    const match = feature.postProcess?.find((p) => p.option === option);
    if (match) return match;
  }
  return null;
}

/** Notify features that a new image was loaded (invalidate cached maps, etc.). */
export function notifyExperimentalImageLoaded(injector: Injector): void {
  for (const feature of EXPERIMENTAL_FEATURES) {
    feature.onImageLoaded?.(injector);
  }
}

/** Overlays experimental features currently want drawn on the canvas.
 *  Callers gate on the experimental flag before drawing. */
export function collectExperimentalOverlays(
  injector: Injector
): CanvasImageSource[] {
  return EXPERIMENTAL_FEATURES.map(
    (f) => f.getOverlay?.(injector) ?? null
  ).filter((overlay): overlay is CanvasImageSource => overlay !== null);
}
