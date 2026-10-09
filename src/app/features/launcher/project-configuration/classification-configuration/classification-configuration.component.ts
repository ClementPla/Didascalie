import { Component, inject } from '@angular/core';
import { LabelsService } from '../../../../services/labels/labels.service';
import { FormsModule } from '@angular/forms';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';

import { Fieldset } from 'primeng/fieldset';
import { DividerModule } from 'primeng/divider';
import { InputTextModule } from 'primeng/inputtext';
import { MultilabelTask } from '../../../../core/task';

import { TagModule } from 'primeng/tag';

@Component({
    selector: 'app-classification-configuration',
    imports: [FormsModule, ButtonModule, CheckboxModule, TagModule, Fieldset, InputTextModule, DividerModule],
    templateUrl: './classification-configuration.component.html',
    styleUrl: './classification-configuration.component.scss'
})
export class ClassificationConfigurationComponent {
  labelService = inject(LabelsService);

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
