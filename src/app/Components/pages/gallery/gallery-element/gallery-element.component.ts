import {
  Component,
  Input,
  Output,
  EventEmitter,
  ElementRef,
  OnDestroy,
  OnChanges,
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  NgZone,
} from '@angular/core';
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
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GalleryElementComponent
  implements OnDestroy, OnChanges, AfterViewInit
{
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
  @Output() reviewedToggled = new EventEmitter<{
    id: number;
    reviewed: boolean;
  }>();

  // Internal state
  public imagePath = '';
  public isLoading = true;
  public loadError = false;
  public isLooping = false;

  // Derived view state, recomputed only when the inputs it depends on change
  // (see ngOnChanges) instead of on every change-detection pass. With 64 cards
  // per page on the CPU-composited Linux webview, re-running these getters each
  // tick was measurable overhead competing with paint.
  public statusLabel = 'Not started';
  public statusBadgeClass = 'bg-gray-400';
  public cardStyleClass = '';
  public rowBackground = '';
  // Hover preview state
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  public loopInterval: ReturnType<typeof setInterval> | null = null;
  public currentFrameIndex = 0;
  public isFading = false;

  // Lazy loading
  private observer: IntersectionObserver | null = null;
  private hasLoadedThumbnail = false;

  constructor(
    private elementRef: ElementRef,
    private zone: NgZone,
    private cdr: ChangeDetectorRef,
  ) {}

  ngOnChanges(): void {
    this.recomputeDerived();
  }

  ngAfterViewInit(): void {
    this.setupIntersectionObserver();
  }

  /** Recompute the status/selection-derived strings the template binds to. */
  private recomputeDerived(): void {
    switch (this.status) {
      case 'reviewed':
        this.statusLabel = 'Reviewed';
        this.statusBadgeClass = 'bg-green-500';
        break;
      case 'annotated':
        this.statusLabel = 'Annotated';
        this.statusBadgeClass = 'bg-yellow-500';
        break;
      default:
        this.statusLabel = 'Not started';
        this.statusBadgeClass = 'bg-gray-400';
    }

    this.cardStyleClass = this.selected
      ? 'ring-2 ring-primary ring-offset-2'
      : '';

    this.rowBackground = this.computeRowBackground();
  }

  /**
   * Status-dependent row tint (list mode): current selection wins (blue),
   * then reviewed (green), then annotated (orange).
   */
  private computeRowBackground(): string {
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

  ngOnDestroy(): void {
    this.cleanupObserver();
    this.cleanupTimers();
  }
  private setupIntersectionObserver(): void {
    const root = this.elementRef.nativeElement.closest('.gallery-scroll');
    // Run the observer outside Angular so scrolling past cards doesn't spin the
    // change detector on every intersection event. We re-enter the zone only to
    // actually load a thumbnail, and stop observing after the first hit so an
    // already-loaded card never fires again.
    this.zone.runOutsideAngular(() => {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.hasLoadedThumbnail) {
              this.hasLoadedThumbnail = true;
              this.cleanupObserver();
              this.zone.run(() => void this.loadThumbnail(this.frameId));
              break;
            }
          }
        },
        {
          root: root, // viewport
          rootMargin: '100px', // Load slightly before visible
          threshold: 0.1,
        },
      );

      this.observer.observe(this.elementRef.nativeElement);
    });
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
    this.cdr.markForCheck();

    try {
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
      // OnPush + async completion: the mutations above won't be picked up
      // otherwise (the load runs off a zone-external observer / timer).
      this.cdr.markForCheck();
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
    // Fired from a timer, not a template event, so nudge the OnPush view.
    this.cdr.markForCheck();
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
    // Local toggle (not an @Input change), so recompute the selection-derived
    // classes ourselves and flag the OnPush view for re-check.
    this.recomputeDerived();
    this.cdr.markForCheck();

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

  public get displayTitle(): string {
    return this.title || `Sequence ${this.id}`;
  }

  public get isReviewed(): boolean {
    return this.status === 'reviewed';
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
