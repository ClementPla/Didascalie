import { Component, OnInit } from '@angular/core';
import { ProjectService } from '../../../Services/Project/project.service';
import { CommonModule } from '@angular/common';
import { Observable } from 'rxjs';
import { GalleryElementComponent } from './gallery-element/gallery-element.component';
import { PanelModule } from 'primeng/panel';
import { DataViewModule } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';

interface ThumbnailsLoaded {
  path: Observable<string>;
  name: Observable<string>;
}

@Component({
  selector: 'app-gallery',
  standalone: true,
  imports: [CommonModule, GalleryElementComponent, PanelModule, DataViewModule, ButtonModule],
  templateUrl: './gallery.component.html',
  styleUrl: './gallery.component.scss'
})
export class GalleryComponent implements OnInit {

  constructor(public projectService: ProjectService) { }


  ngOnInit(): void {
    setInterval(() => {
      this.refresh();
    }, 2000);
  }
  async refresh() {
    await this.projectService.listFiles();
  }
}
