import { Component, ElementRef, ChangeDetectionStrategy, inject, input, model } from '@angular/core';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';

import { BlockableUI } from 'primeng/api';
import { TooltipModule } from 'primeng/tooltip';
@Component({
    selector: 'app-labelled-switch',
    imports: [ToggleSwitchModule, FormsModule, TooltipModule],
    templateUrl: './labelled-switch.component.html',
    styleUrl: './labelled-switch.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LabelledSwitchComponent implements BlockableUI {
  private el = inject(ElementRef);

  /** Two-way: callers bind `[(checked)]`. `model()` supplies `checkedChange`. */
  readonly checked = model(false);
  readonly tooltipLabel = input<string | null>(null);

  getBlockableElement(): HTMLElement {
    return this.el.nativeElement.children[0];
  }
}
