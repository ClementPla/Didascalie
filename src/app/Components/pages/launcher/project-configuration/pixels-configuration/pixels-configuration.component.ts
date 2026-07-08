import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { LabelsService } from '../../../../../Services/Labels/labels.service';
import { FormsModule } from '@angular/forms';
import { ColorPickerModule } from 'primeng/colorpicker';
import { ButtonModule } from 'primeng/button';
import { SegLabel } from '../../../../../Core/interface';
import { getDefaultColor } from '../../../../../Core/misc/colors';


@Component({
    selector: 'app-pixels-configuration',
    imports: [CommonModule, FormsModule, ColorPickerModule, ButtonModule],
    templateUrl: './pixels-configuration.component.html',
    styleUrl: './pixels-configuration.component.scss'
})
export class PixelsConfigurationComponent {
  constructor(public labelService: LabelsService) { }

  deleteSegmentationClass(segLabel: SegLabel) {
    this.labelService.removeSegLabel(segLabel);
  }


  addSegmentationClass() {
    const color = getDefaultColor(
      this.labelService.listSegmentationLabels.length + 1
    );
    this.labelService.addSegLabel({
      label: 'Class ' + this.labelService.listSegmentationLabels.length,
      color: color,
      isVisible: true,
      shades: null,
      id: this.labelService.generateNewSegLabelID()
    });
  }


}
