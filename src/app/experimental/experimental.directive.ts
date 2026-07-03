import {
  Directive,
  effect,
  input,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';
import { ExperimentalFeature } from './descriptor';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Renders the host template only while experimental features are enabled.
 * The "decorator for HTML": tag any template chunk that belongs to an
 * experimental feature and it disappears when the switch is off.
 *
 * ```html
 * <div *experimental="'crf'">…CRF-only UI…</div>
 * ```
 */
@Directive({ selector: '[experimental]', standalone: true })
export class ExperimentalDirective {
  /** Which feature this UI belongs to (kept for future per-feature flags). */
  readonly experimental = input.required<ExperimentalFeature>();

  constructor(
    templateRef: TemplateRef<unknown>,
    viewContainer: ViewContainerRef,
    flags: FeatureFlagsService
  ) {
    effect(() => {
      if (flags.isEnabled(this.experimental())) {
        if (viewContainer.length === 0) {
          viewContainer.createEmbeddedView(templateRef);
        }
      } else {
        viewContainer.clear();
      }
    });
  }
}
