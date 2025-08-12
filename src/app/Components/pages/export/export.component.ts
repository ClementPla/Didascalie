import { ChangeDetectorRef, Component } from '@angular/core';
import { PanelModule } from 'primeng/panel';
import { DividerModule } from 'primeng/divider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';
import { ProjectService } from '../../../Services/Project/project.service';
import { FloatLabelModule } from 'primeng/floatlabel';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { LabelsService } from '../../../Services/Project/labels.service';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { listen } from '@tauri-apps/api/event';
import { KnobModule } from 'primeng/knob';
import { RadioButtonModule } from 'primeng/radiobutton';
import { SelectButtonModule } from   'primeng/selectbutton';
@Component({
  selector: 'app-export',
  standalone: true,
  imports: [
    PanelModule,
    DividerModule,
    ToggleSwitchModule,
    FormsModule,
    FloatLabelModule,
    InputTextModule,
    ButtonModule,
    KnobModule,
    SelectButtonModule,
    RadioButtonModule,
  ],
  templateUrl: './export.component.html',
  styleUrl: './export.component.scss',
})
export class ExportComponent {
  exportIndividualMask: boolean = true;
  exportCombinedMask: boolean = true;
  exportColorMap: boolean = true;
  
  
  totalFiles: number = 0;
  filesExported: number = 0;

  exportOptionsDefinedRevisions = [{"label": "All", "value": false}, {"label": "Reviewed", "value": true}];
  exportOption = true;


  constructor(
    public projectService: ProjectService,
    private labelService: LabelsService,
    private cdr: ChangeDetectorRef
  ) {
    this.setup_listener();
  }

  async export() {
    this.filesExported = 0;
    const exportFolder = await path.join(
      this.projectService.outputFolder,
      this.projectService.projectName,
      'export'
    );
    const inputFolder = await path.join(
      this.projectService.outputFolder,
      this.projectService.projectName,
      'annotations'
    );
    invoke('export', {
      outputFolder: exportFolder,
      inputFolder: inputFolder,
      filesReviewed: this.projectService.imagesHasBeenOpened,
      individualMask: this.exportIndividualMask,
      combinedMask: this.exportCombinedMask,
      colormap: this.exportColorMap,
      onlyReviewed: this.exportOption,
    })
      .then(() => {})
      .catch((e) => {
        console.error(e);
      });
  }
  setup_listener() {
    listen('export', (event) => {
      this.totalFiles = event.payload as number;
      this.cdr.detectChanges();
    });
    listen('export-progress', (event) => {
      console.log(event.payload);
      this.filesExported += event.payload as number;
      this.cdr.detectChanges();
    });
  }
}
