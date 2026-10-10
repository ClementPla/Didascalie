import { Injector, Type } from '@angular/core';
import { PostProcessOption } from '../core/tools';
import {
  ExperimentalFeatureDescriptor,
  ExperimentalPostProcess,
} from './descriptor';
import { MEDSAM_FEATURE } from './medsam/medsam.feature';
import { SUPERPIXEL_FEATURE } from './superpixel/superpixel.feature';
import { VOLUME3D_FEATURE } from './volume3d/volume3d.feature';

/** All experimental features. Register a new feature by adding it here. */
export const EXPERIMENTAL_FEATURES: ExperimentalFeatureDescriptor[] = [
  MEDSAM_FEATURE,
  SUPERPIXEL_FEATURE,
  VOLUME3D_FEATURE,
];

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

export function experimentalEditorPanes(): Type<unknown>[] {
  return EXPERIMENTAL_FEATURES.flatMap((f) => f.editorPanes ?? []);
}

export function experimentalCanvasOverlays(): Type<unknown>[] {
  return EXPERIMENTAL_FEATURES.flatMap((f) => f.canvasOverlays ?? []);
}

export function notifyExperimentalImageLoaded(injector: Injector): void {
  for (const feature of EXPERIMENTAL_FEATURES) {
    feature.onImageLoaded?.(injector);
  }
}

export function collectExperimentalOverlays(
  injector: Injector
): CanvasImageSource[] {
  return EXPERIMENTAL_FEATURES.map(
    (f) => f.getOverlay?.(injector) ?? null
  ).filter((overlay): overlay is CanvasImageSource => overlay !== null);
}
