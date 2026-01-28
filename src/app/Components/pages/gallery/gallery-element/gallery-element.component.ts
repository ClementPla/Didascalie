import { Component, Input, Output, EventEmitter, OnInit, ElementRef, OnDestroy, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { SelectButtonModule } from 'primeng/selectbutton';
import { invoke } from '@tauri-apps/api/core';

import { UIStateService } from '../../../../Services/uistate.service';
import { ProjectService } from '../../../../Services/ProjectService/project.service';
import { api } from '../../../../lib/api';

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
export class GalleryElementComponent implements OnDestroy, AfterViewInit {
  // Frame data
  @Input() frameId!: number;
  @Input() title: string = '';
  @Input() status: 'empty' | 'annotated' | 'reviewed' = 'empty';
  @Input() frameCount: number = 1;

  // Display options
  @Input() id!: number; // Sequence ID for selection tracking
  @Input() imgSize: number = 256;
  @Input() selected: boolean = false;
  @Input() frameIds: number[] = [];
  // Events
  @Output() thumbnailSelected = new EventEmitter<ThumbnailSelectionEvent>();
  @Output() thumbnailClicked = new EventEmitter<void>();

  // Internal state
  public imagePath: string = '';
  public isLoading: boolean = true;
  public loadError: boolean = false;
  public isLooping: boolean = false;
  // Hover preview state
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  public loopInterval: ReturnType<typeof setInterval> | null = null;
  public currentFrameIndex: number = 0;
  public isFading: boolean = false;

   // Lazy loading
  private observer: IntersectionObserver | null = null;
  private hasLoadedThumbnail: boolean = false;


   constructor(private elementRef: ElementRef) {}


  ngAfterViewInit(): void {
    this.setupIntersectionObserver();
  }

  ngOnDestroy(): void {
    this.cleanupObserver();
    this.cleanupTimers();
  }
  private setupIntersectionObserver(): void {
    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !this.hasLoadedThumbnail) {
            this.loadThumbnail(this.frameId);
            this.hasLoadedThumbnail = true;
            // Optionally disconnect after first load
            // this.observer?.disconnect();
          }
        });
      },
      {
        root: null, // viewport
        rootMargin: '100px', // Load slightly before visible
        threshold: 0.1,
      }
    );

    this.observer.observe(this.elementRef.nativeElement);
  }

  private cleanupObserver(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private cleanupTimers(): void {
    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
  }

  // ==========================================
  // Thumbnail Loading
  // ==========================================

  private async loadThumbnail(frameId: number): Promise<void> {
    this.isLoading = true;
    this.loadError = false;

    try {
      // const result = await api.getFrameThumbnail(frameId, this.imgSize);
      const result = await api.getFrameThumbnail(frameId, this.imgSize);
      this.imagePath = result.image_base64;
    } catch (error) {
      console.error('Error loading thumbnail:', error);
      this.loadError = true;

      // Fallback: try loading full image
      try {
        const fullImage = await api.getFrameImage(frameId);
        this.imagePath = fullImage.image_base64;
      } catch (fallbackError) {
        console.error('Fallback image load also failed:', fallbackError);
      }
    } finally {
      this.isLoading = false;
    }
  }

  // ==========================================
  // Hover Preview (for sequences with multiple frames)
  // ==========================================

  public onMouseEnter(): void {
    const frameIds = this.frameIds; // Use cached, don't await here
    if (frameIds.length <= 1) return;

    if (this.hoverTimer || this.loopInterval) return; // Already active

    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.startLoop();
    }, 400);
  }

  public onMouseLeave(): void {
    const frameIds = this.frameIds; // Use cached, don't await here
    if (frameIds.length <= 1) return;

    if (this.hoverTimer) {
      clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    this.isLooping = false;
    this.resetToFirstFrame();
  }

  private startLoop(): void {
    if (this.loopInterval) return; // Guard: already looping

    this.isLooping = true;
    this.loopInterval = setInterval(() => {
      this.advanceFrame();
    }, 750);
  }

  private async advanceFrame(): Promise<void> {
    if (this.isLoading) return; // Guard: previous frame still loading

    this.isLoading = true;
    try {
      const frameIds = await this.getFrameIds();
      this.currentFrameIndex = (this.currentFrameIndex + 1) % frameIds.length;
      await this.loadThumbnail(frameIds[this.currentFrameIndex]);
    } finally {
      this.isLoading = false;
    }
  }

  private async resetToFirstFrame(): Promise<void> {
    this.currentFrameIndex = 0;
    await this.loadThumbnail(this.frameId);
  }

  // ==========================================
  // User Actions
  // ==========================================

  /**
   * Open editor at this sequence.
   */
  public openEditor(): void {
    this.thumbnailClicked.emit();
  }

  /**
   * Handle thumbnail selection with optional shift-click for range selection.
   */
  public select(event: MouseEvent): void {
    event.stopPropagation();

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
    const classes: string[] = [];

    if (this.selected) {
      classes.push('ring-2', 'ring-primary', 'ring-offset-2');
    }

    return classes.join(' ');
  }

  public getStatusBadgeClass(): string {
    switch (this.status) {
      case 'reviewed':
        return 'bg-green-500';
      case 'annotated':
        return 'bg-yellow-500';
      case 'empty':
      default:
        return 'bg-gray-400';
    }
  }

  public getStatusLabel(): string {
    switch (this.status) {
      case 'reviewed':
        return 'Reviewed';
      case 'annotated':
        return 'Annotated';
      case 'empty':
      default:
        return 'Not started';
    }
  }

  public get displayTitle(): string {
    return this.title || `Sequence ${this.id}`;
  }

  public get hasMultipleFrames(): boolean {
    return this.frameCount > 1;
  }

  async getFrameIds(): Promise<number[]> {
    const frames = await api.getSequenceFrames(this.id);
    return frames.map((f) => f.id);
  }
}
