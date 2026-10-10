import {
  Directive,
  effect,
  inject,
  input,
  TemplateRef,
  ViewContainerRef,
} from '@angular/core';
import { ExperimentalFeature } from './descriptor';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Renders the host template only while experimental features are enabled.
 *
 * ```html
 * <div *experimental="'superpixel'">…</div>
 * ```
 */
@Directive({ selector: '[experimental]', standalone: true })
export class ExperimentalDirective {
  readonly experimental = input.required<ExperimentalFeature>();

  private readonly templateRef = inject<TemplateRef<unknown>>(TemplateRef);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly flags = inject(FeatureFlagsService);

  constructor() {
    const { templateRef, viewContainer, flags } = this;
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
