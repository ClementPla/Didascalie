import { AfterViewInit, Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';


import { ProjectService } from '../../../../Services/Project/project.service';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../../../../Core/save_load';


@Component({
  selector: 'app-gallery-element',
  standalone: true,
  imports: [CommonModule, CardModule, PanelModule],
  templateUrl: './gallery-element.component.html',
  styleUrl: './gallery-element.component.scss'
})
export class GalleryElementComponent implements OnInit {
  @Input() imageName: string;
  @Input() id: number;
  imagePath: string = '';

  constructor(private projectService: ProjectService) {
  }

  ngOnInit(): void {
    this.getThumbnail().then((path) => {
      this.imagePath = path;
    });
  }



  openEditor() {
    let id = this.projectService.imagesName.indexOf(this.imageName);
    this.projectService.openEditor(id);
  }

  async getThumbnail(): Promise<string> {
    let imageInput = await path.resolve(this.projectService.inputFolder, this.imageName);
    let thumbnailPath = await path.resolve(this.projectService.inputFolder, '.thumbnails', this.imageName);
    await invoke('create_thumbnail', { imagePath: imageInput, thumbnailPath: thumbnailPath, width: 128, height: 128 })
    return loadImageFile(thumbnailPath);
  }
}