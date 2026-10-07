import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';
import { MedsamService } from './medsam.service';

/** Settings pane for the MedSAM post-process mode, rendered by the tool
 *  settings panel through the experimental registry. */
@Component({
  selector: 'app-medsam-settings',
  standalone: true,
  imports: [FormsModule, InputTextModule, SliderModule, TooltipModule],
  templateUrl: './medsam-settings.component.html',
})
export class MedsamSettingsComponent {
  medsam = inject(MedsamService);
}
