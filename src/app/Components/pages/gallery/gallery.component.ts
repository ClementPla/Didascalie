import { Component, OnInit } from '@angular/core';
import { ProjectService } from '../../../Services/Project/project.service';
import { CommonModule } from '@angular/common';
import { GalleryElementComponent } from './gallery-element/gallery-element.component';
import { PanelModule } from 'primeng/panel';
import { DataViewModule } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { KnobModule } from 'primeng/knob';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-gallery',
  standalone: true,
  imports: [
    CommonModule,
    GalleryElementComponent,
    PanelModule,
    DataViewModule,
    ButtonModule,
    KnobModule,
    FormsModule,
  ],
  templateUrl: './gallery.component.html',
  styleUrl: './gallery.component.scss',
})
export class GalleryComponent implements OnInit {
  refreshInterval: number = 3000;
  percentageBeforeRefresh: number = 0;
  intervalFunction: NodeJS.Timeout | undefined;
  constructor(public projectService: ProjectService) {}

  ngOnInit(): void {
    this.intervalFunction = this.getInterval();
  }
  async refresh() {
    this.percentageBeforeRefresh = 0;
    if (this.intervalFunction) {
      clearInterval(this.intervalFunction);
    }
    await this.projectService.listFiles();
    this.intervalFunction = this.getInterval();
  }

  getInterval() {
    let interval = 50;
    return setInterval(() => {
      this.percentageBeforeRefresh += 100 * (interval / this.refreshInterval);
      console.log(this.percentageBeforeRefresh);
      if (this.percentageBeforeRefresh >= 100) {
        this.refresh();
        this.percentageBeforeRefresh = 0;
      }
    }, interval);
  }
}
