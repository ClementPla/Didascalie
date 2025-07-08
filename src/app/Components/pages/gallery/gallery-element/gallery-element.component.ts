import { Component, Input, OnInit, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ProjectService } from '../../../../Services/Project/project.service';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../../../../Core/save_load';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { ViewService } from '../../../../Services/UI/view.service';
import { ClassificationService } from '../../../../Services/Project/classification.service';

@Component({
  selector: 'app-gallery-element',
  standalone: true,
  imports: [CommonModule, CardModule, PanelModule, SelectButtonModule],
  templateUrl: './gallery-element.component.html',
  styleUrl: './gallery-element.component.scss',
})
export class GalleryElementComponent implements OnInit {
  @Input() img: string[];
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

  getCardStyleClass() {
    if (this.selected) {
      return 'bg-primary';
    }
    return '';
  }
  async openEditor() {
    let id = this.projectService.imagesName.indexOf(this.getImageName());

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

  getImageName() {
    return this.img[0];
  }

  async getThumbnail(): Promise<string> {
    let imageName = this.getImageName();
    let imageInput = await path.resolve(
      this.projectService.inputFolder,
      imageName
    );
    if (this.projectService.generateThumbnails) {
      let thumbnailPath = await path.resolve(
        this.projectService.inputFolder,
        '.thumbnails',
        imageName
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
