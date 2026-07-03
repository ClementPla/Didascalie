import { computed, Injectable, Injector, signal } from '@angular/core';
import { postProcessingOptions } from '../Core/tools';
import { EditorService } from '../Components/pages/editor/services/editor.service';
import { ExperimentalFeature } from './descriptor';
import {
  EXPERIMENTAL_FEATURES,
  experimentalPostProcessOptions,
  isExperimentalPostProcess,
} from './registry';

const STORAGE_KEY = 'didascalie.experimentalFeatures';

/**
 * Master switch for experimental features, persisted across sessions.
 * UI reads the signals; feature code checks `isEnabled` at its entry points.
 */
@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  readonly experimentalEnabled = signal(
    localStorage.getItem(STORAGE_KEY) === 'true'
  );

  /** Post-process modes to display: the stable ones, plus the experimental
   *  ones while the experimental switch is on. */
  readonly visiblePostProcessOptions = computed(() =>
    this.experimentalEnabled()
      ? [...postProcessingOptions, ...experimentalPostProcessOptions()]
      : postProcessingOptions
  );

  constructor(
    private injector: Injector,
    private editorService: EditorService
  ) {}

  isEnabled(_feature: ExperimentalFeature): boolean {
    // Single master switch for now; the parameter keeps call sites tagged so
    // per-feature flags can be introduced later without touching them.
    return this.experimentalEnabled();
  }

  setExperimentalEnabled(enabled: boolean): void {
    this.experimentalEnabled.set(enabled);
    localStorage.setItem(STORAGE_KEY, String(enabled));
    if (enabled) return;

    // Roll back anything experimental that is still visible or selected.
    for (const feature of EXPERIMENTAL_FEATURES) {
      feature.onDisabled?.(this.injector);
    }
    if (isExperimentalPostProcess(this.editorService.postProcessOption)) {
      this.editorService.postProcessOption = postProcessingOptions[0];
    }
  }
}
