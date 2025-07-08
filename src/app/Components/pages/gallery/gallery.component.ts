import {
  Component,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { ProjectService } from '../../../Services/Project/project.service';
import { CommonModule } from '@angular/common';
import { GalleryElementComponent } from './gallery-element/gallery-element.component';
import { PanelModule } from 'primeng/panel';
import { DataViewModule, DataView } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { KnobModule } from 'primeng/knob';
import { FormsModule } from '@angular/forms';
import { GenericsModule } from '../../../generics/generics.module';
import { SelectButton, SelectButtonModule } from 'primeng/selectbutton';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { LabelsService } from '../../../Services/Project/labels.service';
import { ClassificationService } from '../../../Services/Project/classification.service';
import { IOService } from '../../../Services/Project/io.service';
import { SliderModule } from 'primeng/slider';
import { MultiframesService } from '../../../Services/Project/multiframes.service';
import { path } from '@tauri-apps/api';
import { GalleryService } from './gallery.service';

interface GalleryItem {
  img: string[];
  status: string;
  title: string;
  id: number; // Optional ID for easier selection

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
    SelectButtonModule,
    InputTextModule,
    ToggleSwitchModule,
    SliderModule,
  ],
  standalone: true,
  templateUrl: './gallery.component.html',
  styleUrl: './gallery.component.scss',
})
export class GalleryComponent implements OnInit, OnDestroy {
  autoRefresh: boolean = false;
  showAdvancedFilters: boolean = false;

  imgSize: number = 256;
  refreshInterval: number = 3000;
  percentageBeforeRefresh: number = 0;
  intervalFunction: NodeJS.Timeout | undefined;
  galleryItems: GalleryItem[] = [];
  filterTitle: string = '';
  selectedItems: number[] = [];
  @ViewChildren('batchChoices') batchChoices: QueryList<SelectButton>;

  filterOptions = [
    { label: 'All', value: 0 },
    { label: 'Images w. pre-annotations', value: 1 },
    { label: 'Images w.o annotations', value: 2 },
    { label: 'Images reviewed', value: 3 },
  ];

  @ViewChild('dv') dataView: DataView;
  

  constructor(
    public projectService: ProjectService,
    public labelsService: LabelsService,
    public classificationService: ClassificationService,
    private IOService: IOService,
    private multiframesService: MultiframesService,
    public galleryService: GalleryService
  ) {}

  async ngOnInit(): Promise<void> {
    await this.refresh();
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
    if (JSON.stringify(this.galleryItems) !== JSON.stringify(newItems)) {
      this.galleryItems = newItems;
    }
    if (this.autoRefresh) {
      this.intervalFunction = this.getInterval();
    }
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
    if (this.projectService.folderAsMultiframes) {
      for (const key of this.multiframesService.groupedFrames.keys()) {
        let frames = this.multiframesService.groupedFrames.get(key)!;
        
        // Get the image name of the first frame
        let imgPath = frames[0];
        let imgName = this.projectService.extractImagesName([imgPath])[0];
        let status = this.getStatusForImage(imgName);
        // Get name without extension
        let names = this.projectService.extractImagesName(frames);
        items.push({
          img: names,
          status: status,
          title: imgName,
          id: this.projectService.imagesName.indexOf(imgName), // Assign an ID for easier selection
        } as GalleryItem);
      }
    }
    else {
      for (let i = 0; i < this.projectService.imagesName.length; i++) {
        let imgName = this.projectService.imagesName[i];
        
        let status = this.getStatusForImage(imgName)
        items.push({
          img: [this.projectService.imagesName[i]],
          status: status,
          title: imgName,
          id: i, // Assign an ID for easier selection
        } as GalleryItem);
      }
    }
    return items;
  }

  getStatusForImage(imgName: string): string {
    // Get name without extension
    let name = imgName.split('.').slice(0, -1).join('.');
    if (this.projectService.annotationsName.includes(name + '.svg')) {
      return 'annotated';
    } else if (this.projectService.imagesHasBeenOpened.includes(imgName)) {
      return 'reviewed';
    } else {
      return 'empty';
    }
  }


  toggleFilter(event: any) {
    if (event.value == 0) {
      this.dataView.filter('');
    } else if (event.value == 1) {
      this.dataView.filter('annotated');
    } else if (event.value == 2) {
      this.dataView.filter('empty');
    } else {
      this.dataView.filter('reviewed');
    }
  }

  addTitleFilter() {
    this.dataView.filter(this.filterTitle);
  }

  handleSelect(event: any) {

    let id = event[0];
    let selected = event[1];
    let isShift = event[2];

    if (selected) {
      if (isShift) {
        let last = this.selectedItems[this.selectedItems.length - 1];

        for (let i = last + 1; i <= id; i++) {
          if (this.dataView.filteredValue) {
            if (this.dataView.filteredValue.includes(this.dataView.value![i])) {
              if (!this.selectedItems.includes(i)) {
                this.selectedItems.push(i);
              }
            }
          } else {
            if (!this.selectedItems.includes(i)) {
              this.selectedItems.push(i);
            }
          }
        }
      } else {
        if (!this.selectedItems.includes(id)) {
          this.selectedItems.push(id);
        }
      }
    } else {
      this.selectedItems = this.selectedItems.filter((i) => i !== id);
    }
  }

  annotateBatch() {
    let choices = this.batchChoices.toArray().map((item) => item.value);

    this.selectedItems.forEach((id) => {
      let filename = this.galleryItems[id].img;
     
      for (let i = 0; i < choices.length; i++) {
        this.classificationService.multiclassChoices.get(filename[0])![i] =
          choices[i];
      }
    });
    this.IOService.saveClassification();
    this.deselectAll();
  }

  deselectAll() {
    this.selectedItems = [];
  }

  onLazyLoad(event: any) {
    console.log('Lazy load event:', event);
    this.galleryService.first = event.first;
    // Handle lazy loading logic here if needed
  }
}
