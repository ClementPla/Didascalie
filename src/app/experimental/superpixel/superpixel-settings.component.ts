import { Component } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { SliderModule } from 'primeng/slider';
import { GenericsModule } from '../../generics/generics.module';
import { SuperpixelService } from './superpixel.service';

/** Settings pane for the superpixel post-process mode, rendered by the tool
 *  settings panel through the experimental registry. */
@Component({
  selector: 'app-superpixel-settings',
  standalone: true,
  imports: [FormsModule, InputTextModule, SliderModule, GenericsModule],
  templateUrl: './superpixel-settings.component.html',
})
export class SuperpixelSettingsComponent {
  constructor(public superpixel: SuperpixelService) {}

  /** Toggle the superpixel boundary overlay on/off. */
  onToggleOverlay() {
    void this.superpixel.updateOverlay();
  }

  onCountChange() {
    this.superpixel.onCountChanged();
  }
}
