import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SliderModule } from 'primeng/slider';
import { LabelledSwitchComponent } from '../../shared/generics/labelled-switch/labelled-switch.component';
import { SuperpixelService } from './superpixel.service';

@Component({
  selector: 'app-superpixel-settings',
  standalone: true,
  imports: [FormsModule, InputTextModule, SliderModule, LabelledSwitchComponent],
  templateUrl: './superpixel-settings.component.html',
})
export class SuperpixelSettingsComponent {
  superpixel = inject(SuperpixelService);

  onToggleOverlay() {
    void this.superpixel.updateOverlay();
  }

  onCountChange() {
    this.superpixel.onCountChanged();
  }
}
