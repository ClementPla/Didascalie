import { Component, ElementRef, Input, Output, ViewChild } from '@angular/core';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';
import { EventEmitter } from '@angular/core';
import { BlockableUI } from 'primeng/api';
import { TooltipModule } from 'primeng/tooltip';
@Component({
  selector: 'app-labelled-switch',
  standalone: true,
  imports: [ToggleSwitchModule, FormsModule, TooltipModule],
  templateUrl: './labelled-switch.component.html',
  styleUrl: './labelled-switch.component.scss',
})
export class LabelledSwitchComponent implements BlockableUI {
  @Input() checked: boolean;
  @Output() checkedChange = new EventEmitter<boolean>();
  @Input() tooltipLabel: string | null = null;

  updateCheck() {
    this.checkedChange.emit(this.checked);
  }
  constructor(private el: ElementRef) {}

  getBlockableElement(): HTMLElement {
    return this.el.nativeElement.children[0];
  }
}
