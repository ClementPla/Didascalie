import { Component, Input, Output, EventEmitter, OnInit, ElementRef, OnDestroy, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { invoke } from '@tauri-apps/api/core';

import { LabelledSwitchComponent } from '../../../../generics/labelled-switch/labelled-switch.component';

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
  imports: [
    CommonModule,
    CardModule,
    PanelModule,
    SelectButtonModule,
    ButtonModule,
    TooltipModule,
    LabelledSwitchComponent,
  ],
  templateUrl: './gallery-element.component.html',
  styleUrl: './gallery-element.component.scss',
})
export class GalleryElementComponent implements OnDestroy, AfterViewInit {
  // Frame data
  @Input() frameId!: number;
  @Input() title = '';
  @Input() status: 'empty' | 'annotated' | 'reviewed' = 'empty';
  @Input() frameCount = 1;
  /** Whether the sequence contains at least one keypoint pair (registration). */
  @Input() hasKeypoints = false;

  // Display options
  @Input() id!: number; // Sequence ID for selection tracking
  @Input() imgSize = 256;
  @Input() selected = false;
  @Input() frameIds: number[] = [];
  /** Render as a full-width list row instead of a card. */
  @Input() listMode = false;
  /** Show the per-row "Reviewed" toggle (list mode only). */
  @Input() showReviewedToggle = true;
  /** Tint the row background by status / current selection (list mode only). */
  @Input() colorByStatus = false;
  // Events
  @Output() thumbnailSelected = new EventEmitter<ThumbnailSelectionEvent>();
  @Output() thumbnailClicked = new EventEmitter<void>();
  @Output() reviewedToggled = new EventEmitter<{ id: number; reviewed: boolean }>();

  // Internal state
  public imagePath = '';
  public isLoading = true;
  public loadError = false;
  public isLooping = false;
  // Hover preview state
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  public loopInterval: ReturnType<typeof setInterval> | null = null;
  public currentFrameIndex = 0;
  public isFading = false;

   // Lazy loading
  private observer: IntersectionObserver | null = null;
  private hasLoadedThumbnail = false;


   constructor(private elementRef: ElementRef) {}


  ngAfterViewInit(): void {
    this.setupIntersectionObserver();
  }

  ngOnDestroy(): void {
    this.cleanupObserver();
    this.cleanupTimers();
  }
  private setupIntersectionObserver(): void {
    const root = this.elementRef.nativeElement.closest('.gallery-scroll');
    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !this.hasLoadedThumbnail) {
            this.loadThumbnail(this.frameId);
            this.hasLoadedThumbnail = true;
          }
        });
      },
      {
        root: root, // viewport
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
    const frameIds = this.frameIds; 
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
  public select(event: Event): void {
    event.stopPropagation();

    this.selected = !this.selected;

    const isShiftClick =
      'shiftKey' in event && (event as MouseEvent | KeyboardEvent).shiftKey;

    this.thumbnailSelected.emit({
      id: this.id,
      selected: this.selected,
      isShiftClick,
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

  public get isReviewed(): boolean {
    return this.status === 'reviewed';
  }

  /**
   * Status-dependent row tint (list mode): current selection wins (blue),
   * then reviewed (green), then annotated (orange).
   */
  public getRowBackground(): string {
    if (!this.colorByStatus) return '';
    if (this.selected) return 'rgba(59, 130, 246, 0.22)'; // blue – current
    switch (this.status) {
      case 'reviewed':
        return 'rgba(34, 197, 94, 0.20)'; // green
      case 'annotated':
        return 'rgba(245, 158, 11, 0.20)'; // orange
      default:
        return '';
    }
  }

  /** Emit a request to (un)mark the whole sequence as reviewed. */
  public onReviewedToggle(reviewed: boolean): void {
    this.reviewedToggled.emit({ id: this.id, reviewed });
  }

  public get hasMultipleFrames(): boolean {
    return this.frameCount > 1;
  }

  async getFrameIds(): Promise<number[]> {
    const frames = await api.getSequenceFrames(this.id);
    return frames.map((f) => f.id);
  }
}
