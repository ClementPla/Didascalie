import { Component, Input, OnInit, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';

import { SelectButtonModule } from 'primeng/selectbutton';
import { ProjectService } from '../../../../Services/Project/project.service';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../../../../Core/save_load';
import { NgStyle } from '@angular/common';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { ViewService } from '../../../../Services/UI/view.service';
import { ClassificationService } from '../../../../Services/Project/classification.service';

@Component({
  selector: 'app-gallery-element',
  standalone: true,
  imports: [CommonModule, CardModule, PanelModule, NgStyle, SelectButtonModule],
  templateUrl: './gallery-element.component.html',
  styleUrl: './gallery-element.component.scss',
})
export class GalleryElementComponent implements OnInit {
  @Input() imageName: string;
  @Input() id: number;
  @Input() status: string;
  @Input() imgSize: number;
  @Output() thumbnailSelected = new EventEmitter<[number, boolean, boolean]>();
  imagePath: string = '';
  @Input() selected: boolean = false;
  constructor(
    public projectService: ProjectService,
    public labelsService: LabelsService,
    public classificatorService: ClassificationService,
    private viewService: ViewService
  ) {}

  ngOnInit(): void {
    this.getThumbnail().then((path) => {
      this.imagePath = path;
    });
  }

  getStyle() {
    if (this.status === 'annotated') {
      return { border: '4px solid #FFA500' };
    } else if (this.status === 'reviewed') {
      return { border: '4px solid rgb(0, 255, 0)' };
    } else {
      return {
        border: '4px solid rgb(255, 0, 0)',
      };
    }
  }

  getCardStyleClass() {
    if (this.selected) {
      return 'bg-primary';
    }
    return '';
  }
  openEditor() {
    let id = this.projectService.imagesName.indexOf(this.imageName);
    this.viewService.openEditor(id);
  }
  select(event: MouseEvent) {
    this.selected = !this.selected;
    if (event.shiftKey) {
      this.thumbnailSelected.emit([this.id, this.selected, true]);
    } else {
      this.thumbnailSelected.emit([this.id, this.selected, false]);
    }
  }

  async getThumbnail(): Promise<string> {
    let imageInput = await path.resolve(
      this.projectService.inputFolder,
      this.imageName
    );
    if (this.projectService.generateThumbnails) {
      let thumbnailPath = await path.resolve(
        this.projectService.inputFolder,
        '.thumbnails',
        this.imageName
      );
      await invoke('create_cache_thumbnail', {
        imagePath: imageInput,
        thumbnailPath: thumbnailPath,
        width: 256,
        height: 256,
      });
      return loadImageFile(thumbnailPath);
    } else {
      let data = await invoke('create_thumbnail', {
        imagePath: imageInput,
        width: 256,
        height: 256,
      });

      return 'data:image/png;base64,' + data;
    }
  }
}
