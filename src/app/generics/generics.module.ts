import { NgModule } from '@angular/core';
import { BlockableDiv } from './blockable/div/div.component';
import { BlockableP } from './blockable/p/p.component';
import { LabelledSwitchComponent } from './labelled-switch/labelled-switch.component';
import { CommonModule } from '@angular/common';

@NgModule({
  declarations: [],
  imports: [CommonModule, BlockableDiv, BlockableP, LabelledSwitchComponent],
  exports: [BlockableDiv, BlockableP, LabelledSwitchComponent],
})
export class GenericsModule {}
