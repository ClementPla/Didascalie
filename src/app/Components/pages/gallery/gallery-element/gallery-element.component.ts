// gallery-element.component.ts
import { Component, Input, Output, EventEmitter, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { SelectButtonModule } from 'primeng/selectbutton';

import { ProjectService } from '../../../../Services/ProjectService/project.service';
import { NavigationService } from '../../../../Services/Navigation/navigation.service';
import { UIStateService } from '../../../../Services/uistate.service';
import { ThumbnailService } from '../../../../Services/thumbnail.service';
import { LabelsService } from '../../../../Services/Labels/labels.service';
import { ClassificationService } from '../../../../Services/Labels/classification.service';

export interface ThumbnailSelectionEvent {
  id: number;
  selected: boolean;
  isShiftClick: boolean;
}

@Component({
  selector: 'app-gallery-element',
  imports: [CommonModule, CardModule, PanelModule, SelectButtonModule],
  templateUrl: './gallery-element.component.html',
  styleUrl: './gallery-element.component.scss',
})
export class GalleryElementComponent implements OnInit {
  @Input() img: string[];
  @Input() id: number;
  @Input() status: string;
  @Input() imgSize: number;
  @Input() selected: boolean = false;

  @Output() thumbnailSelected = new EventEmitter<ThumbnailSelectionEvent>();

  public imagePath: string = '';
  private hoverTimer: any;
  private loopInterval: any;
  public currentImgIndex: number = 0;
  public isFading: boolean = false;

  constructor(
    public projectService: ProjectService,
    public labelsService: LabelsService,
    public classificationService: ClassificationService,
    private navigationService: NavigationService,
    private uiState: UIStateService,
    private thumbnailService: ThumbnailService
  ) {}

  async ngOnInit(): Promise<void> {
    try {
      this.imagePath = await this.loadThumbnailForIndex(0);
    } catch (error) {
      console.error('Failed to load thumbnail:', error);
      // Keep imagePath empty - template should handle this
    }
  }

  private async startLoop(): Promise<void> {
    this.loopInterval = setInterval(async () => {
      this.isFading = false; // Reset animation state

      this.currentImgIndex = (this.currentImgIndex + 1) % this.img.length;
      const nextPath = await this.loadThumbnailForIndex(this.currentImgIndex);

      this.imagePath = nextPath;

      // Small timeout to allow the DOM to register the reset before re-applying
      setTimeout(() => {
        this.isFading = true;
      }, 10);
    }, 1500);
  }

  // ==========================================
  // User Actions
  // ==========================================

  /**
   * Open editor at this image's index.
   */
  public async openEditor(): Promise<void> {
    const imageName = this.getImageName();
    const imageIndex = this.projectService.imagesName.indexOf(imageName);

    if (imageIndex === -1) {
      console.error(`Image not found in project: ${imageName}`);
      return;
    }

    this.uiState.setLoading(true, 'Opening image');

    try {
      await this.navigationService.navigateToIndex(imageIndex);
      await this.uiState.navigateToEditor();
    } catch (error) {
      console.error('Failed to open editor:', error);
    } finally {
      this.uiState.endLoading();
    }
  }

  /**
   * Handle thumbnail selection with optional shift-click for range selection.
   */
  public select(event: MouseEvent): void {
    this.selected = !this.selected;

    this.thumbnailSelected.emit({
      id: this.id,
      selected: this.selected,
      isShiftClick: event.shiftKey,
    });
  }

  // ==========================================
  // View Helpers
  // ==========================================

  public getCardStyleClass(): string {
    return this.selected ? 'bg-primary' : '';
  }

  public getImageName(): string {
    return this.img[0];
  }

  // ==========================================
  // Thumbnail Loading
  // ==========================================

  /**
   * Load thumbnail for this gallery element.
   * Delegates to ThumbnailService for actual loading logic.
   */

  public async onMouseEnter(): Promise<void> {
    if (this.img.length <= 1) return;

    // Start loop after 400ms delay
    this.hoverTimer = setTimeout(() => {
      this.startLoop();
    }, 400);
  }

  public onMouseLeave(): void {
    clearTimeout(this.hoverTimer);
    clearInterval(this.loopInterval);
    this.isFading = false; // Stop animation
    this.resetLoop();
  }

  private async resetLoop(): Promise<void> {
    this.currentImgIndex = 0;
    this.imagePath = await this.loadThumbnailForIndex(0);
  }

  private async loadThumbnailForIndex(index: number): Promise<string> {
    const imageName = this.img[index];
    return await this.thumbnailService.getThumbnail(imageName);
  }
}
