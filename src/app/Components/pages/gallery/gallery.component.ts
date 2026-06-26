import {
  AfterViewInit,
  ChangeDetectorRef,
  Component,
  NgZone,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// PrimeNG
import { PanelModule } from 'primeng/panel';
import { DataViewModule } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { KnobModule } from 'primeng/knob';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';

// Services
import { ProjectService } from '../../../Services/ProjectService/project.service';
import { SequenceService } from '../../../Services/sequence.service';
import { LabelsService } from '../../../Services/Labels/labels.service';
import { GalleryService } from './gallery.service';
import { BatchAnnotationService } from '../../../Services/Labels/batch-annotation.service';
import { UIStateService } from '../../../Services/uistate.service';
import { api } from '../../../lib/api';

// Components
import {
  GalleryElementComponent,
  ThumbnailSelectionEvent,
} from './gallery-element/gallery-element.component';
import { GenericsModule } from '../../../generics/generics.module';
import { NavigationEnd, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

interface GalleryItem {
  frameIds: number[];
  status: SequenceStatus;
  title: string;
  sequenceId: number;
  sequenceName: string;
  frameCount: number;
  thumbnailFrameId: number;
  /** Fraction of frames reviewed, 0..1. Used for progress sorting. */
  progress: number;
  /** True if the sequence contains at least one keypoint pair. */
  hasKeypoints: boolean;
}

@Component({
  selector: 'app-gallery',
  imports: [
    CommonModule,
    GalleryElementComponent,
    PanelModule,
    DataViewModule,
    ButtonModule,
    KnobModule,
    FormsModule,
    GenericsModule,
    SelectButtonModule,
    SelectModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    ToggleSwitchModule,
    SliderModule,
    TooltipModule,
  ],
  templateUrl: './gallery.component.html',
  styleUrl: './gallery.component.scss',
})
export class GalleryComponent implements AfterViewInit, OnDestroy {
  // View options
  autoRefresh = false;

  // Refresh
  refreshInterval = 3000;
  percentageBeforeRefresh = 0;
  intervalFunction: ReturnType<typeof setInterval> | undefined;

  // Data
  galleryItems: GalleryItem[] = [];
  filteredItems: GalleryItem[] = [];
  selectedItems: number[] = [];

  // Filter state

  maxFrameCount = 0;

  // Batch annotation state
  batchMulticlassChoices: Array<string | null> = [];
  batchMultilabelChoices: string[] = [];

  readonly statusOptions: { label: string; value: SequenceStatus }[] = [
    { label: 'Not started', value: 'empty' },
    { label: 'In progress', value: 'annotated' },
    { label: 'Reviewed', value: 'reviewed' },
  ];

  readonly sortOptions = [
    { label: 'Name (A-Z)', value: 'name-asc' },
    { label: 'Name (Z-A)', value: 'name-desc' },
    { label: 'Most frames', value: 'frames-desc' },
    { label: 'Fewest frames', value: 'frames-asc' },
    { label: 'Most progress', value: 'progress-desc' },
    { label: 'Least progress', value: 'progress-asc' },
  ];

  readonly keypointFilterOptions = [
    { label: 'All', value: 'all' as const },
    { label: 'With keypoints', value: 'with' as const },
    { label: 'Without', value: 'without' as const },
  ];

  readonly layoutOptions = [
    { icon: 'pi pi-th-large', value: 'grid' as const, label: 'Grid view' },
    { icon: 'pi pi-bars', value: 'list' as const, label: 'List view' },
  ];

  constructor(
    public projectService: ProjectService,
    public sequenceService: SequenceService,
    public labelsService: LabelsService,
    public galleryService: GalleryService,
    private batchAnnotationService: BatchAnnotationService,
    private uiState: UIStateService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
  ) {
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        filter((e) => e.urlAfterRedirects.startsWith('/gallery')),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.zone.run(() => void this.refresh());
      });
  }

  async ngAfterViewInit(): Promise<void> {
    this.initBatchChoices();
    await this.refresh();
  }

  ngOnDestroy(): void {
    if (this.intervalFunction) {
      clearInterval(this.intervalFunction);
    }
  }

  // ==========================================
  // Initialization
  // ==========================================

  private initBatchChoices(): void {
    this.batchMulticlassChoices =
      this.labelsService.listClassificationTasks.map(() => null);
    this.batchMultilabelChoices = [];
  }

  // ==========================================
  // Refresh & Auto-refresh
  // ==========================================

  async refresh(): Promise<void> {
    this.percentageBeforeRefresh = 0;
    if (this.intervalFunction) {
      clearInterval(this.intervalFunction);
    }

    const newItems = await this.getItems();

    if (JSON.stringify(this.galleryItems) !== JSON.stringify(newItems)) {
      this.galleryItems = newItems;
    }

    this.maxFrameCount = this.galleryItems.reduce(
      (max, item) => Math.max(max, item.frameCount),
      0,
    );
    if (!this.galleryService.frameRangeInitialized) {
      this.galleryService.frameCountRange = [0, this.maxFrameCount];
      this.galleryService.frameRangeInitialized = true;
    }

    this.applyFilters();

    if (this.autoRefresh) {
      this.intervalFunction = this.getInterval();
    }
  }

  getInterval(): ReturnType<typeof setInterval> {
    const interval = 50;
    return setInterval(() => {
      this.percentageBeforeRefresh += 100 * (interval / this.refreshInterval);
      if (this.percentageBeforeRefresh >= 100) {
        this.refresh();
        this.percentageBeforeRefresh = 0;
      }
    }, interval);
  }

  setupAutoRefresh(): void {
    if (this.autoRefresh) {
      this.intervalFunction = this.getInterval();
    } else {
      clearInterval(this.intervalFunction);
    }
  }

  // ==========================================
  // Load Gallery Items
  // ==========================================

  async getItems(): Promise<GalleryItem[]> {
    this.uiState.setLoading(true, 'Loading gallery items...');
    try {
      // Two queries total instead of N+1
      const [sequences, frameIdsBySequence] = await Promise.all([
        api.getGallerySequences(),
        api.getAllFrameIdsBySequence(),
      ]);

      return sequences
        .filter((seq) => seq.frame_count > 0)
        .map((seq) => ({
          sequenceId: seq.id,
          sequenceName: seq.name,
          title: seq.name,
          frameCount: seq.frame_count,
          thumbnailFrameId: seq.first_frame_id!,
          status: this.computeStatus(seq.reviewed_count, seq.frame_count),
          progress:
            seq.frame_count > 0 ? seq.reviewed_count / seq.frame_count : 0,
          frameIds: frameIdsBySequence[seq.id] ?? [],
          hasKeypoints: seq.has_keypoints,
        }));
    } catch (error) {
      console.error('Failed to load gallery items:', error);
      return [];
    } finally {
      this.uiState.endLoading();
    }
  }

  private computeStatus(reviewed: number, total: number): SequenceStatus {
    if (reviewed === 0) return 'empty';
    if (reviewed >= total) return 'reviewed';
    return 'annotated';
  }

  // ==========================================
  // Filtering & Sorting
  // ==========================================

  applyFilters(): void {
    let items = [...this.galleryItems];

    const query = this.galleryService.filterTitle.trim().toLowerCase();
    if (query) {
      items = items.filter((item) => item.title.toLowerCase().includes(query));
    }

    if (this.galleryService.selectedStatuses.length > 0) {
      items = items.filter((item) =>
        this.galleryService.selectedStatuses.includes(item.status),
      );
    }

    if (this.galleryService.keypointFilter !== 'all') {
      const wantKeypoints = this.galleryService.keypointFilter === 'with';
      items = items.filter((item) => item.hasKeypoints === wantKeypoints);
    }

    if (this.galleryService.showAdvancedFilters) {
      const [min, max] = this.galleryService.frameCountRange;
      items = items.filter(
        (item) => item.frameCount >= min && item.frameCount <= max,
      );
    }

    items.sort((a, b) => this.compareItems(a, b));
    this.filteredItems = items;
    this.cdr.markForCheck();
  }

  private compareItems(a: GalleryItem, b: GalleryItem): number {
    switch (this.galleryService.sortKey) {
      case 'name-desc':
        return b.title.localeCompare(a.title);
      case 'frames-desc':
        return b.frameCount - a.frameCount;
      case 'frames-asc':
        return a.frameCount - b.frameCount;
      case 'progress-desc':
        return b.progress - a.progress;
      case 'progress-asc':
        return a.progress - b.progress;
      case 'name-asc':
      default:
        return a.title.localeCompare(b.title);
    }
  }

  resetFilters(): void {
    this.galleryService.filterTitle = '';
    this.galleryService.selectedStatuses = [];
    this.galleryService.keypointFilter = 'all';
    this.galleryService.sortKey = 'name-asc';
    this.galleryService.frameCountRange = [0, this.maxFrameCount];
    this.applyFilters();
  }

  /** True when any count-affecting filter is active (used for the footer + reset). */
  get hasActiveFilters(): boolean {
    const rangeNarrowed =
      this.galleryService.showAdvancedFilters &&
      (this.galleryService.frameCountRange[0] > 0 ||
        this.galleryService.frameCountRange[1] < this.maxFrameCount);
    return (
      this.galleryService.filterTitle.trim() !== '' ||
      this.galleryService.selectedStatuses.length > 0 ||
      this.galleryService.keypointFilter !== 'all' ||
      rangeNarrowed
    );
  }

  // ==========================================
  // Selection
  // ==========================================

  handleSelect(event: ThumbnailSelectionEvent): void {
    const { id: sequenceId, selected, isShiftClick } = event;

    if (!selected) {
      this.selectedItems = this.selectedItems.filter((id) => id !== sequenceId);
      return;
    }

    // Range selection follows the currently visible/sorted order.
    if (isShiftClick && this.selectedItems.length > 0) {
      const lastSequenceId = this.selectedItems[this.selectedItems.length - 1];
      const lastIndex = this.filteredItems.findIndex(
        (item) => item.sequenceId === lastSequenceId,
      );
      const currentIndex = this.filteredItems.findIndex(
        (item) => item.sequenceId === sequenceId,
      );

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        for (let i = start; i <= end; i++) {
          const id = this.filteredItems[i].sequenceId;
          if (!this.selectedItems.includes(id)) {
            this.selectedItems.push(id);
          }
        }
        return;
      }
    }

    if (!this.selectedItems.includes(sequenceId)) {
      this.selectedItems.push(sequenceId);
    }
  }

  deselectAll(): void {
    this.selectedItems = [];
  }

  selectAll(): void {
    this.selectedItems = this.filteredItems.map((item) => item.sequenceId);
  }

  // ==========================================
  // Navigation
  // ==========================================

  async openItem(item: GalleryItem): Promise<void> {
    if (this.sequenceService.sequences().length === 0) {
      await this.sequenceService.loadSequences();
    }
    const sequence = this.sequenceService
      .sequences()
      .find((s) => s.id === item.sequenceId);
    if (sequence) {
      await this.sequenceService.selectSequence(sequence);
    } else {
      console.error(`Failed to find sequence with ID ${item.sequenceId}`);
    }
    this.uiState.navigateToEditor();
  }

  // ==========================================
  // Batch Annotation
  // ==========================================

  public setBatchMulticlassChoice(taskIndex: number, value: string): void {
    this.batchMulticlassChoices[taskIndex] = value;
  }

  public async annotateBatch(): Promise<void> {
    if (this.selectedItems.length === 0) {
      console.warn('No images selected for batch annotation');
      return;
    }

    const frameIds = this.getSelectedFrameIds();
    if (frameIds.length === 0) {
      console.error('Failed to extract frame IDs from selected items');
      return;
    }

    this.uiState.setLoading(
      true,
      `Applying batch annotations to ${frameIds.length} frames`,
    );

    try {
      // Apply multiclass classifications
      const hasMulticlassChoices = this.batchMulticlassChoices.some(
        (c) => c !== null,
      );
      if (hasMulticlassChoices) {
        const result =
          await this.batchAnnotationService.applyBatchMulticlassToFrames(
            frameIds,
            this.batchMulticlassChoices,
          );

        if (!result.success) {
          console.error('Batch multiclass annotation failed:', result.errors);
        }
      }

      // Apply multilabel classifications
      if (this.batchMultilabelChoices.length > 0) {
        const result =
          await this.batchAnnotationService.applyBatchMultilabelToFrames(
            frameIds,
            this.batchMultilabelChoices,
          );

        if (!result.success) {
          console.error('Batch multilabel annotation failed:', result.errors);
        }
      }

      this.deselectAll();
      this.resetBatchChoices();
      await this.refresh();
    } catch (error) {
      console.error('Failed to apply batch annotations:', error);
    } finally {
      this.uiState.endLoading();
    }
  }

  public async markSelectedAsReviewed(reviewed = true): Promise<void> {
    if (this.selectedItems.length === 0) {
      return;
    }

    // selectedItems holds sequence IDs, so resolve frame IDs by ID lookup.
    const frameIds = this.getSelectedFrameIds();
    if (frameIds.length === 0) {
      console.error('Failed to extract frame IDs from selected sequences');
      return;
    }

    this.uiState.setLoading(
      true,
      `Marking ${frameIds.length} frames as ${
        reviewed ? 'reviewed' : 'unreviewed'
      }`,
    );

    try {
      const result = await this.batchAnnotationService.markFramesReviewed(
        frameIds,
        reviewed,
      );

      if (result.success) {
        this.deselectAll();
        await this.refresh();
      } else {
        console.error('Failed to mark frames as reviewed:', result.errors);
      }
    } catch (error) {
      console.error('Failed to mark frames as reviewed:', error);
    } finally {
      this.uiState.endLoading();
    }
  }

  /**
   * Mark a single sequence (all its frames) reviewed / unreviewed from the
   * list view. Updates local state immediately to avoid a full reload flicker.
   */
  public async onItemReviewedToggle(event: {
    id: number;
    reviewed: boolean;
  }): Promise<void> {
    const item = this.galleryItems.find((i) => i.sequenceId === event.id);
    if (!item || item.frameIds.length === 0) {
      return;
    }

    try {
      const result = await this.batchAnnotationService.markFramesReviewed(
        item.frameIds,
        event.reviewed,
      );
      if (!result.success) {
        console.error('Failed to mark sequence as reviewed:', result.errors);
        return;
      }

      item.status = event.reviewed ? 'reviewed' : 'empty';
      item.progress = event.reviewed ? 1 : 0;
      this.applyFilters();
    } catch (error) {
      console.error('Failed to mark sequence as reviewed:', error);
    }
  }

  private resetBatchChoices(): void {
    this.batchMulticlassChoices =
      this.labelsService.listClassificationTasks.map(() => null);
    this.batchMultilabelChoices = [];
  }

  // ==========================================
  // Getters for Template
  // ==========================================

  get totalItems(): number {
    return this.galleryItems.length;
  }

  get selectedCount(): number {
    return this.selectedItems.length;
  }

  get hasSelection(): boolean {
    return this.selectedItems.length > 0;
  }

  get hasBatchChoices(): boolean {
    return (
      this.batchMulticlassChoices.some((c) => c !== null) ||
      this.batchMultilabelChoices.length > 0
    );
  }

  private getSelectedFrameIds(): number[] {
    return this.selectedItems.flatMap((sequenceId) => {
      const item = this.galleryItems.find((i) => i.sequenceId === sequenceId);
      return item?.frameIds ?? [];
    });
  }
}
