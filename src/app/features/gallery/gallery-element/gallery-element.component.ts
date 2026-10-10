import { DOUBLE_TAP_MS, TAP_SLOP } from '../../../core/touch';
import { Component, Input, ElementRef, OnDestroy, OnChanges, AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, NgZone, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { CardModule } from 'primeng/card';
import { PanelModule } from 'primeng/panel';
import { SelectButtonModule } from 'primeng/selectbutton';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { LabelledSwitchComponent } from '../../../shared/generics/labelled-switch/labelled-switch.component';

import { api } from '../../../lib/api';

export interface ThumbnailSelectionEvent {
  id: number;
  selected: boolean;
  isShiftClick: boolean;
}

/** How many frames of a sequence its card shows on hover. */
const MAX_PREVIEW_FRAMES = 10;

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
  private elementRef = inject(ElementRef);
  private zone = inject(NgZone);
  private cdr = inject(ChangeDetectorRef);

  readonly frameId = input.required<number>();
  readonly title = input('');
  readonly status = input<'empty' | 'annotated' | 'reviewed'>('empty');
  readonly frameCount = input(1);
  /** The sequence has at least one keypoint pair. */
  readonly hasKeypoints = input(false);

  readonly id = input.required<number>(); // Sequence ID for selection tracking
  readonly imgSize = input(256);
  @Input() selected = false;
  readonly frameIds = input<number[]>([]);
  /** The frames the hover preview cycles through: at most
   *  `MAX_PREVIEW_FRAMES`, spread evenly. Each one shown is a decode. */
  readonly previewFrameIds = computed(() => {
    const ids = this.frameIds();
    if (ids.length <= MAX_PREVIEW_FRAMES) return ids;
    const last = MAX_PREVIEW_FRAMES - 1;
    return Array.from(
      { length: MAX_PREVIEW_FRAMES },
      (_, i) => ids[Math.round((i * (ids.length - 1)) / last)],
    );
  });
  /** A full-width list row instead of a card. */
  readonly listMode = input(false);
  readonly showReviewedToggle = input(true);
  /** Tint the row by status and selection (list mode). */
  readonly colorByStatus = input(false);
  readonly thumbnailSelected = output<ThumbnailSelectionEvent>();
  readonly thumbnailClicked = output<void>();
  readonly inspectClicked = output<void>();
  readonly pairingClicked = output<void>();
  readonly reviewedToggled = output<{
    id: number;
    reviewed: boolean;
}>();

  public imagePath = '';
  public isLoading = true;
  public loadError = false;
  public isLooping = false;

  // Derived view state, recomputed in ngOnChanges, not on every change
  // detection.
  public statusLabel = 'Not started';
  public statusBadgeClass = 'bg-gray-400';
  public cardStyleClass = '';
  public rowBackground = '';
  private hoverTimer: ReturnType<typeof setTimeout> | null = null;
  public loopInterval: ReturnType<typeof setInterval> | null = null;
  public currentFrameIndex = 0;
  public isFading = false;

  private observer: IntersectionObserver | null = null;
  private hasLoadedThumbnail = false;

  ngOnChanges(): void {
    this.recomputeDerived();
  }

  ngAfterViewInit(): void {
    this.setupIntersectionObserver();
  }

  private recomputeDerived(): void {
    switch (this.status()) {
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

  /** Row tint (list mode): selection (blue), then reviewed (green), then
   *  annotated (orange). */
  private computeRowBackground(): string {
    if (!this.colorByStatus()) return '';
    if (this.selected) return 'rgba(59, 130, 246, 0.22)'; // blue – current
    switch (this.status()) {
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
    // Observed outside Angular: scrolling past cards must not run change
    // detection. Observation stops at the first hit.
    this.zone.runOutsideAngular(() => {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.hasLoadedThumbnail) {
              this.hasLoadedThumbnail = true;
              this.cleanupObserver();
              this.zone.run(() => void this.loadThumbnail(this.frameId()));
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

  // ── Thumbnail Loading ────────────────────────────────────────────────────

  private async loadThumbnail(frameId: number): Promise<void> {
    this.isLoading = true;
    this.loadError = false;
    this.cdr.markForCheck();

    try {
      const result = await api.getFrameThumbnail(frameId, this.imgSize());
      this.imagePath = result.imageBase64;
    } catch (error) {
      console.error('Error loading thumbnail:', error);
      this.loadError = true;

      // Fall back to the full image.
      try {
        const fullImage = await api.getFrameImage(frameId);
        this.imagePath = fullImage.imageBase64;
      } catch (fallbackError) {
        console.error('Fallback image load also failed:', fallbackError);
      }
    } finally {
      this.isLoading = false;
      // OnPush, and this runs from outside the zone.
      this.cdr.markForCheck();
    }
  }

  // ── Touch ────────────────────────────────────────────────────────────────
  // A finger has no hover and no reliable double-click: holding it down plays
  // the preview, and two quick taps open the sequence.

  private touchDownAt: { x: number; y: number } | null = null;
  private lastTapAt = 0;
  /** When a finger last touched this card, to tell the mouse events Android
   *  synthesises after a tap from a real mouse. */
  private lastTouchAt = 0;

  public onTouchDown(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    this.lastTouchAt = performance.now();
    this.touchDownAt = { x: event.clientX, y: event.clientY };
    this.startPreviewSoon();
  }

  public onTouchUp(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    const down = this.touchDownAt;
    this.onTouchCancel(event);
    if (!down) return;
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > TAP_SLOP) {
      return; // a scroll, not a tap
    }
    const now = performance.now();
    if (now - this.lastTapAt < DOUBLE_TAP_MS) {
      this.lastTapAt = 0;
      this.openEditor();
    } else {
      this.lastTapAt = now;
    }
  }

  public onTouchCancel(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    this.lastTouchAt = performance.now();
    this.touchDownAt = null;
    this.onMouseLeave();
  }

  public onMouseEnter(): void {
    // The hover Android invents after a tap would never end.
    if (performance.now() - this.lastTouchAt < 1000) return;
    this.startPreviewSoon();
  }

  private startPreviewSoon(): void {
    if (this.previewFrameIds().length <= 1) return;

    if (this.hoverTimer || this.loopInterval) return; // Already active

    this.hoverTimer = setTimeout(() => {
      this.hoverTimer = null;
      this.startLoop();
    }, 400);
  }

  public onMouseLeave(): void {
    if (this.previewFrameIds().length <= 1) return;

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
    // From a timer: mark the OnPush view.
    this.cdr.markForCheck();
    this.loopInterval = setInterval(() => {
      this.advanceFrame();
    }, 750);
  }

  private async advanceFrame(): Promise<void> {
    if (this.isLoading) return; // Guard: previous frame still loading

    this.isLoading = true;
    try {
      const frameIds = this.previewFrameIds();
      this.currentFrameIndex = (this.currentFrameIndex + 1) % frameIds.length;
      await this.loadThumbnail(frameIds[this.currentFrameIndex]);
    } finally {
      this.isLoading = false;
    }
  }

  private async resetToFirstFrame(): Promise<void> {
    this.currentFrameIndex = 0;
    await this.loadThumbnail(this.frameId());
  }

  // ── User Actions ─────────────────────────────────────────────────────────

  private lastOpenedAt = 0;

  public openEditor(): void {
    // A double tap can arrive twice: counted above, and as a dblclick.
    const now = performance.now();
    if (now - this.lastOpenedAt < 600) return;
    this.lastOpenedAt = now;
    this.thumbnailClicked.emit();
  }

  /** Select the thumbnail; shift-click selects a range. */
  public select(event: Event): void {
    event.stopPropagation();

    this.selected = !this.selected;
    this.recomputeDerived();
    this.cdr.markForCheck();

    const isShiftClick =
      'shiftKey' in event && (event as MouseEvent | KeyboardEvent).shiftKey;

    this.thumbnailSelected.emit({
      id: this.id(),
      selected: this.selected,
      isShiftClick,
    });
  }

  // ── View Helpers ─────────────────────────────────────────────────────────

  public get displayTitle(): string {
    return this.title() || `Sequence ${this.id()}`;
  }

  public get isReviewed(): boolean {
    return this.status() === 'reviewed';
  }

  public onReviewedToggle(reviewed: boolean): void {
    this.reviewedToggled.emit({ id: this.id(), reviewed });
  }

  public get hasMultipleFrames(): boolean {
    return this.frameCount() > 1;
  }

  /** Keypoints pair two frames of one sequence. */
  public get canPair(): boolean {
    return this.frameCount() > 1;
  }
}
