import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';
import { MedsamService } from './medsam.service';

@Component({
  selector: 'app-medsam-settings',
  standalone: true,
  imports: [FormsModule, InputTextModule, SliderModule, TooltipModule],
  templateUrl: './medsam-settings.component.html',
})
export class MedsamSettingsComponent {
  medsam = inject(MedsamService);
}
