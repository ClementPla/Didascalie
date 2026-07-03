import { Component } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { PopoverModule } from 'primeng/popover';
import { TooltipModule } from 'primeng/tooltip';
import { GenericsModule } from '../../generics/generics.module';
import { FeatureFlagsService } from '../feature-flags.service';
import { EXPERIMENTAL_FEATURES } from '../registry';

/** Toolbar button + popover with the "Experimental features" master switch
 *  and the list of features it controls. */
@Component({
  selector: 'app-experimental-settings',
  standalone: true,
  imports: [ButtonModule, PopoverModule, TooltipModule, GenericsModule],
  templateUrl: './experimental-settings.component.html',
})
export class ExperimentalSettingsComponent {
  readonly features = EXPERIMENTAL_FEATURES;

  constructor(public flags: FeatureFlagsService) {}
}
