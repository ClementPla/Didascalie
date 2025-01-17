import { Component, Input } from '@angular/core';
import { SegLabel } from '../../../../../Core/interface';
import { ProjectService } from '../../../../../Services/Project/project.service';
import { generate_shades } from '../../../../../Core/misc/colors';
import { NgFor, NgClass } from '@angular/common';
import { LabelsService } from '../../../../../Services/Project/labels.service';


@Component({
  selector: 'app-instance-label',
  standalone: true,
  imports: [NgFor, NgClass],
  templateUrl: './instance-label.component.html',
  styleUrl: './instance-label.component.scss'
})
export class InstanceLabelComponent {

  @Input() label: SegLabel;
  shades: string[] = [];

  constructor(private projectService:ProjectService, public labelService: LabelsService) { 

  }


  ngOnInit(): void {
    this.shades = this.getShades();
  }

  getShades(){
    if(this.shades.length !== this.projectService.maxInstances){
      this.shades = generate_shades(this.label.color, this.projectService.maxInstances);
    }
    this.label.shades = this.shades
    return this.shades;
    



  }
  changeActive(index: number){
    this.labelService.activeSegInstance = {label: this.label, instance: index, shade: this.getShades()[index]};
    
  }
  
}
