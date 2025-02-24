import { Injectable } from '@angular/core';
import { LabelsService } from './labels.service';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class ClassificationService {
  multiclassChoices: Map<string, Array<string|null>> = new Map();
  multilabelChoices: Map<string, Array<string>> = new Map();

  requestReload: Subject<boolean> = new Subject();
  requestSave: Subject<boolean> = new Subject();

  constructor(private labelsService: LabelsService) {}

  initMaps(filenames: Array<string>) {
    filenames.forEach((filename) => {
      if (!this.multiclassChoices.has(filename)){
        let defaultArray = new Array<string|null>(this.labelsService.listClassificationTasks.length);
        defaultArray.fill(null);
        this.multiclassChoices.set(filename, defaultArray);
      }
    });
    filenames.forEach((filename) => {
      if (!this.multilabelChoices.has(filename))
        this.multilabelChoices.set(filename, []);
    });
    this.requestReload.next(true);
  }


  generateCSV(): string{
    let csv = 'filename,';
    this.labelsService.listClassificationTasks.forEach((task) => {
      csv += task.taskName + ',';
    });
    this.labelsService.multiLabelTask?.taskLabels.forEach((label) => {
      csv += label + ',';
    });

    csv += '\n';
    this.multiclassChoices.forEach((value, key) => {
      csv += key + ',';
      value.forEach((choice) => {
        if (choice != null) {
          csv += choice + ',';
        } else {
          csv += ',';
        }
      });


      this.labelsService.multiLabelTask?.taskLabels.forEach((label) => {
        if (this.multilabelChoices.get(key)?.includes(label)){
          csv += '1,';
        }
        else{
          csv += '0,';
        }
      });

      csv += '\n';
    });
    return csv;
  }

  loadCSV(csv: string){
    let lines = csv.split('\n');
    let header = lines[0].split(',');
    for (let i = 1; i < lines.length; i++){
      let values = lines[i].split(',');
      if (values.length < 2){
        continue;
      }
      let filename = values[0];
      this.multiclassChoices.set(filename, []);
      for (let j = 1; j < values.length; j++){
        if (j <= this.labelsService.listClassificationTasks.length){
          this.multiclassChoices.get(filename)![j-1] = values[j];
        }
        else{
          if (values[j] === '1'){
            this.multilabelChoices.get(filename)?.push(header[j]);
          }
        }
      }
    }
  }
}
