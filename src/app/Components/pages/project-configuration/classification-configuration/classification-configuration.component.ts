import { Component } from '@angular/core';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
import { NgFor, NgIf, NgStyle } from '@angular/common';
import { Fieldset } from 'primeng/fieldset';
import { DividerModule } from 'primeng/divider';
import { InputTextModule } from 'primeng/inputtext';
import { MultilabelTask } from '../../../../Core/task';

import { TagModule } from 'primeng/tag';

@Component({
  selector: 'app-classification-configuration',
  standalone: true,
  imports: [FormsModule, ButtonModule, CheckboxModule, NgFor, NgIf, TagModule, Fieldset, InputTextModule, DividerModule],
  templateUrl: './classification-configuration.component.html',
  styleUrl: './classification-configuration.component.scss'
})
export class ClassificationConfigurationComponent {

  constructor(public labelService: LabelsService) { }

  addMulticlassTask(){
    this.labelService.addNewClassificationTask();
  }

  addMultiLabelTask(){
    this.labelService.multiLabelTask = new MultilabelTask('Multilabel', []);

  }

  addClassToTask(taskIndex: number){
    const n = this.labelService.listClassificationTasks[taskIndex].classLabels.length;
    this.labelService.listClassificationTasks[taskIndex].classLabels.push('Class ' + (n + 1));
  }

  removeClassFromTask(taskIndex: number, classIndex: number){
    this.labelService.listClassificationTasks[taskIndex].classLabels.splice(classIndex, 1);
  

  }

  addMultiLabelClass(name: string, event: Event){
    if(name === '') return;
    if(!this.labelService.multiLabelTask){
      return;
    }
    if(this.labelService.multiLabelTask.taskLabels.includes(name)){
      return;
    }
    this.labelService.multiLabelTask.taskLabels.push(name);

    (event.target as HTMLInputElement).value = '';
    

  }

  trackByFn(index: number): number {
    return index;
  }

  removeTask(taskIndex: number){
    this.labelService.listClassificationTasks.splice(taskIndex, 1);
  }

  removeClassFromMultitask(classIndex: number){
    if(!this.labelService.multiLabelTask){
      return;
    }

    this.labelService.multiLabelTask.taskLabels.splice(classIndex, 1);
  }

}
