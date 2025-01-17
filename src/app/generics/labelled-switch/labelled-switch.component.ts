import { Component, ElementRef, Input, Output, ViewChild } from '@angular/core';
import { InputSwitchModule } from 'primeng/inputswitch';
import { FormsModule } from '@angular/forms';
import { EventEmitter } from '@angular/core';
import { BlockableUI } from 'primeng/api';

@Component({
  selector: 'app-labelled-switch',
  standalone: true,
  imports: [InputSwitchModule, FormsModule],
  templateUrl: './labelled-switch.component.html',
  styleUrl: './labelled-switch.component.scss'
})
export class LabelledSwitchComponent implements BlockableUI {

  @Input() checked: boolean;
  @Output() checkedChange = new EventEmitter<boolean>();

  updateCheck(){
    this.checkedChange.emit(this.checked);
  }
  constructor(private el: ElementRef) {
  }

  getBlockableElement(): HTMLElement {
    return this.el.nativeElement.children[0];
  }
}
