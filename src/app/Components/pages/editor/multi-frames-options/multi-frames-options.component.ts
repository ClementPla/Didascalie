import { Component, EventEmitter, HostListener, Output } from '@angular/core';
import { ViewService } from '../../../../Services/UI/view.service';
import { MultiframesService } from '../../../../Services/Project/multiframes.service';
import { ProjectService } from '../../../../Services/Project/project.service';
import { NgIf, CommonModule } from '@angular/common';
import { InputSwitchModule } from 'primeng/inputswitch';
import { FormsModule } from '@angular/forms';
import { SliderModule } from 'primeng/slider';
import { PanelModule } from 'primeng/panel';
@Component({
  selector: 'app-multi-frames-options',
  standalone: true,
  imports: [NgIf, CommonModule, InputSwitchModule, FormsModule, PanelModule, SliderModule],
  templateUrl: './multi-frames-options.component.html',
  styleUrl: './multi-frames-options.component.scss'
})
export class MultiFramesOptionsComponent {
  currentFrame: number = 0;
  _isLoaded: boolean = false;

  @Output() change: EventEmitter<number> = new EventEmitter<number>();

  constructor(
    public projectService: ProjectService,
    private viewService: ViewService,
    public multiframeService: MultiframesService){}


  preload(){
    this.viewService.setLoading(true, 'Preloading frames');
    this.multiframeService.cacheActivegroupFrames();
    this.viewService.endLoading();
  }

  async multiFrameChanged() {
    if (!this._isLoaded) {
      return;
    }
    this.change.emit(this.currentFrame);
   
  }

  @HostListener('window:keydown.ArrowUp', ['$event'])
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
  @HostListener('window:keydown.ArrowDown', ['$event'])
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
