import { Component } from '@angular/core';
import { NgFor } from '@angular/common';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { TextLabel } from '../../../../Core/interface';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';

@Component({
  selector: 'app-text-configuration',
  standalone: true,
  imports: [NgFor, FormsModule, ButtonModule, InputTextModule],
  templateUrl: './text-configuration.component.html',
  styleUrl: './text-configuration.component.scss'
})
export class TextConfigurationComponent {
  constructor(public labelService: LabelsService){}


  removeTextLabel(label: TextLabel){
    this.labelService.removeTextLabel(label)
  }

  addNewTextDescriptionTask(){
    const name = "Default: " + (this.labelService.listTextLabels.length + 1);
    this.labelService.addTextLabel({name: name, text: ''})
  }


}
