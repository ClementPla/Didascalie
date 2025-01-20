import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ProjectService } from '../../../Services/Project/project.service';
import { CommonModule } from '@angular/common';
import { GalleryElementComponent } from './gallery-element/gallery-element.component';
import { PanelModule } from 'primeng/panel';
import { DataViewModule, DataView } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { KnobModule } from 'primeng/knob';
import { FormsModule } from '@angular/forms';
import { GenericsModule } from "../../../generics/generics.module";
import { SelectButtonModule } from 'primeng/selectbutton';

interface GalleryItem {
  title: string;
  src: string;
  status: string;
}


@Component({
  selector: 'app-gallery',
  imports: [
    CommonModule,
    GalleryElementComponent,
    PanelModule,
    DataViewModule,
    ButtonModule,
    KnobModule,
    FormsModule,
    GenericsModule,
    SelectButtonModule
  ],
  standalone: true,
  templateUrl: './gallery.component.html',
  styleUrl: './gallery.component.scss',
})
export class GalleryComponent implements OnInit, OnDestroy {
  autoRefresh: boolean = true;
  refreshInterval: number = 3000;
  percentageBeforeRefresh: number = 0;
  intervalFunction: NodeJS.Timeout | undefined;
  items: GalleryItem[] = [];

  filterOptions = [{ label: 'All', value: 0 },
  { label: 'Images w. annotations', value: 1 },
  { label: 'Images w.o annotations', value: 2 },
  { label: 'Images reviewed', value: 3 },
  ];

  @ViewChild('dv') dataView: DataView;

  constructor(public projectService: ProjectService) {
  }

  async ngOnInit(): Promise<void> {
    await this.refresh()
  }

  ngOnDestroy(): void {
    if (this.intervalFunction) {
      clearInterval(this.intervalFunction);
    }
  }
  async refresh() {
    this.percentageBeforeRefresh = 0;
    if (this.intervalFunction) {
      clearInterval(this.intervalFunction);
    }
    const newItems = await this.getItems();
    // Check if the items are the same
    if (JSON.stringify(this.items) !== JSON.stringify(newItems)) {
      this.items = newItems;
    }
    if (this.autoRefresh) {
      this.intervalFunction = this.getInterval()
    };
  }

  getInterval() {
    let interval = 50;
    return setInterval(() => {
      this.percentageBeforeRefresh += 100 * (interval / this.refreshInterval);
      if (this.percentageBeforeRefresh >= 100) {
        this.refresh();
        this.percentageBeforeRefresh = 0;
      }
    }, interval);
  }
  setupAutoRefresh() {
    if (this.autoRefresh) {
      this.intervalFunction = this.getInterval();
    } else {
      clearInterval(this.intervalFunction);
    }
  }

  async getItems(): Promise<GalleryItem[]> {
    await this.projectService.listFiles();
    await this.projectService.listAnnotations();

    let items = [];
    for (let i = 0; i < this.projectService.imagesName.length; i++) {
      let imgName = this.projectService.imagesName[i];
      // Get name without extension
      let name = imgName.split('.').slice(0, -1).join('.');
      let status = 'empty';
      if (this.projectService.annotationsName.includes(name + '.svg')) {
        status = 'annotated';
      }
      if (this.projectService.imagesHasBeenOpened.includes(imgName)) {
        status = 'reviewed';
      }

      items.push({
        title: this.projectService.imagesName[i],
        src: this.projectService.imagesName[i],
        status: status,
      } as GalleryItem);
    }
    return items;
  }

  toggleFilter(event: any) {
    if (event.value == 0) {
      this.dataView.filter('');
    } else if (event.value == 1) {
      this.dataView.filter('annotated');
    } else if (event.value == 2) {
      this.dataView.filter('empty');
    }
    else {
      this.dataView.filter('reviewed');
    }


  }

}
