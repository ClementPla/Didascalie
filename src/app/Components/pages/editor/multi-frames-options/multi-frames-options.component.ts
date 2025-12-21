import { Component, EventEmitter, HostListener, Output } from '@angular/core';
import { ViewService } from '../../../../Services/UI/view.service';
import { MultiframesService } from '../../../../Services/Project/multiframes.service';
import { ProjectService } from '../../../../Services/ProjectService/project.service';
import { CommonModule } from '@angular/common';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { FormsModule } from '@angular/forms';
import { SliderModule } from 'primeng/slider';
import { PanelModule } from 'primeng/panel';
@Component({
    selector: 'app-multi-frames-options',
    imports: [
        CommonModule,
        ToggleSwitchModule,
        FormsModule,
        PanelModule,
        SliderModule,
    ],
    templateUrl: './multi-frames-options.component.html',
    styleUrl: './multi-frames-options.component.scss'
})
export class MultiFramesOptionsComponent {
  currentFrame: number = 0;
  _isLoaded: boolean = false;

  @Output() changeOfFrame: EventEmitter<number> = new EventEmitter<number>();

  constructor(
    public projectService: ProjectService,
    private viewService: ViewService,
    public multiframeService: MultiframesService
  ) {}

  preload() {
    this.viewService.setLoading(true, 'Preloading frames');
    this.multiframeService.cacheActiveGroupFrames();
    this.viewService.endLoading();
  }

  async multiFrameChanged() {
    if (!this._isLoaded) {
      return;
    }
    
    this.changeOfFrame.emit(this.currentFrame);
  }

  @HostListener('window:keydown.ArrowUp')
  nextFrame() {
    if (this.multiframeService.activeGroup) {
      if (
        this.currentFrame + 1 >=
        this.multiframeService.getLengthOfActiveGroup()
      ) {
        this.currentFrame = 0;
      } else {
        this.currentFrame++;
      }
      this.multiFrameChanged();
    }
  }
  @HostListener('window:keydown.ArrowDown')
  previousFrame() {
    if (this.multiframeService.activeGroup) {
      if (this.currentFrame - 1 < 0) {
        this.currentFrame = this.multiframeService.getLengthOfActiveGroup() - 1;
      } else {
        this.currentFrame--;
      }
      this.multiFrameChanged();
    }
  }
}
