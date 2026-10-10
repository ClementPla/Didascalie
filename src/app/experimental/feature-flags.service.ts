import { computed, Injectable, Injector, signal, inject } from '@angular/core';
import { postProcessingOptions } from '../core/tools';
import { EditorService } from '../features/editor/services/editor.service';
import { ExperimentalFeature } from './descriptor';
import {
  EXPERIMENTAL_FEATURES,
  experimentalPostProcessOptions,
  isExperimentalPostProcess,
} from './registry';

const STORAGE_KEY = 'didascalie.experimentalFeatures';

/** Master switch for experimental features, persisted across sessions. */
@Injectable({ providedIn: 'root' })
export class FeatureFlagsService {
  private injector = inject(Injector);
  private editorService = inject(EditorService);

  readonly experimentalEnabled = signal(
    localStorage.getItem(STORAGE_KEY) === 'true'
  );

  readonly visiblePostProcessOptions = computed(() =>
    this.experimentalEnabled()
      ? [...postProcessingOptions, ...experimentalPostProcessOptions()]
      : postProcessingOptions
  );

  isEnabled(_feature: ExperimentalFeature): boolean {
    // One master switch; the parameter tags call sites for per-feature flags.
    return this.experimentalEnabled();
  }

  setExperimentalEnabled(enabled: boolean): void {
    this.experimentalEnabled.set(enabled);
    localStorage.setItem(STORAGE_KEY, String(enabled));
    if (enabled) return;

    for (const feature of EXPERIMENTAL_FEATURES) {
      feature.onDisabled?.(this.injector);
    }
    if (isExperimentalPostProcess(this.editorService.postProcessOption)) {
      this.editorService.postProcessOption = postProcessingOptions[0];
    }
  }
}
