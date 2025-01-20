import { Component, Input, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';


import { ProjectService } from '../../../../Services/Project/project.service';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { loadImageFile } from '../../../../Core/save_load';
import { NgStyle } from '@angular/common';

@Component({
  selector: 'app-gallery-element',
  standalone: true,
  imports: [CommonModule, CardModule, PanelModule, NgStyle],
  templateUrl: './gallery-element.component.html',
  styleUrl: './gallery-element.component.scss'
})
export class GalleryElementComponent implements OnInit {
  @Input() imageName: string;
  @Input() id: number;
  @Input() status: string;
  imagePath: string = '';

  constructor(private projectService: ProjectService) {
  }

  ngOnInit(): void {
    this.getThumbnail().then((path) => {
      this.imagePath = path;
    });
  }

  getStyle() {
    if (this.status === 'annotated') {
      return { border: "4px solid #FFA500" };
    } else if (this.status === 'reviewed') {
      return { border: '4px solid rgb(0, 255, 0)' };
    } else {
      return {
        border: '4px solid rgb(255, 0, 0)'
      };
    }
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