import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SliderModule } from 'primeng/slider';
import { CrfService } from './crf.service';

/** Settings pane for the CRF post-process mode, rendered by the tool settings
 *  panel through the experimental registry. */
@Component({
  selector: 'app-crf-settings',
  standalone: true,
  imports: [FormsModule, InputTextModule, SliderModule],
  templateUrl: './crf-settings.component.html',
})
export class CrfSettingsComponent {
  constructor(public crf: CrfService) {}
}
