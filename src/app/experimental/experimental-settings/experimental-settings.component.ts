import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { PopoverModule } from 'primeng/popover';
import { TooltipModule } from 'primeng/tooltip';
import { LabelledSwitchComponent } from '../../shared/generics/labelled-switch/labelled-switch.component';
import { FeatureFlagsService } from '../feature-flags.service';
import { EXPERIMENTAL_FEATURES } from '../registry';

@Component({
  selector: 'app-experimental-settings',
  standalone: true,
  imports: [ButtonModule, PopoverModule, TooltipModule, LabelledSwitchComponent],
  templateUrl: './experimental-settings.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExperimentalSettingsComponent {
  flags = inject(FeatureFlagsService);

  readonly features = EXPERIMENTAL_FEATURES;
}
