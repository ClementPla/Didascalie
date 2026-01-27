import {
  Component,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

// PrimeNG
import { PanelModule } from 'primeng/panel';
import { DataViewModule, DataView } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { KnobModule } from 'primeng/knob';
import { SelectButton, SelectButtonModule } from 'primeng/selectbutton';
import { InputTextModule } from 'primeng/inputtext';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SliderModule } from 'primeng/slider';

// Services
import { ProjectService } from '../../../Services/ProjectService/project.service';
import { SequenceService } from '../../../Services/sequence.service';
import { LabelsService } from '../../../Services/Labels/labels.service';
import { GalleryService } from './gallery.service';
import { BatchAnnotationService } from '../../../Services/Labels/batch-annotation.service';
import { UIStateService } from '../../../Services/uistate.service';
import { api, Frame, Sequence } from '../../../lib/api';

// Components
import {
  GalleryElementComponent,
  ThumbnailSelectionEvent,
} from './gallery-element/gallery-element.component';
import { GenericsModule } from '../../../generics/generics.module';

interface GalleryItem {
  frameIds: number[];
  status: 'empty' | 'annotated' | 'reviewed';
  title: string;
  sequenceId: number;
  sequenceName: string;
  frameCount: number;
  thumbnailFrameId: number;
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
    InputTextModule,
    ToggleSwitchModule,
    SliderModule,
  ],
  templateUrl: './gallery.component.html',
  styleUrl: './gallery.component.scss',
})
export class GalleryComponent implements OnInit, OnDestroy {
  autoRefresh: boolean = false;
  showAdvancedFilters: boolean = false;

  imgSize: number = 256;
  refreshInterval: number = 3000;
  percentageBeforeRefresh: number = 0;
  intervalFunction: ReturnType<typeof setInterval> | undefined;
  galleryItems: GalleryItem[] = [];
  filterTitle: string = '';
  selectedItems: number[] = [];

  // Batch annotation state
  batchMulticlassChoices: Array<string | null> = [];
  batchMultilabelChoices: string[] = [];

  @ViewChildren('batchChoices') batchChoices: QueryList<SelectButton>;
  @ViewChild('dv') dataView: DataView;

  filterOptions = [
    { label: 'All', value: 0 },
    { label: 'Annotated', value: 1 },
    { label: 'Not annotated', value: 2 },
    { label: 'Reviewed', value: 3 },
  ];

  constructor(
    public projectService: ProjectService,
    public sequenceService: SequenceService,
    public labelsService: LabelsService,
    public galleryService: GalleryService,
    private batchAnnotationService: BatchAnnotationService,
    private uiState: UIStateService,
  ) {}

  async ngOnInit(): Promise<void> {
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
    // Initialize multiclass choices array to match task count
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
    
    const items: GalleryItem[] = sequences
      .filter(seq => seq.frame_count > 0)
      .map(seq => ({
        sequenceId: seq.id,
        sequenceName: seq.name,
        title: seq.name,
        frameCount: seq.frame_count,
        thumbnailFrameId: seq.first_frame_id!,
        status: this.computeStatus(seq.reviewed_count, seq.frame_count),
        frameIds: frameIdsBySequence[seq.id] ?? [],
      }));
    
    return items;
  } catch (error) {
    console.error('Failed to load gallery items:', error);
    return [];
  } finally {
    this.uiState.endLoading();
  }
}

  private computeStatus(
    reviewed: number,
    total: number,
  ): 'empty' | 'annotated' | 'reviewed' {
    if (reviewed === 0) return 'empty';
    if (reviewed >= total) return 'reviewed';
    return 'annotated';
  }

  private async getFramesForSequence(sequenceId: number): Promise<Frame[]> {
    const currentSequence = this.sequenceService.currentSequence();
    if (currentSequence?.id === sequenceId) {
      return this.sequenceService.frames();
    }

    return api.getSequenceFrames(sequenceId);
  }

  private getStatusForFrames(
    frames: Frame[],
  ): 'empty' | 'annotated' | 'reviewed' {
    const allReviewed = frames.every((f) => f.reviewed);
    if (allReviewed) {
      return 'reviewed';
    }

    const anyReviewed = frames.some((f) => f.reviewed);
    if (anyReviewed) {
      return 'annotated';
    }

    return 'empty';
  }

  // ==========================================
  // Filtering
  // ==========================================

  toggleFilter(event: { value: number }): void {
    if (event.value === 0) {
      this.dataView.filter('');
    } else if (event.value === 1) {
      this.dataView.filter('annotated');
    } else if (event.value === 2) {
      this.dataView.filter('empty');
    } else {
      this.dataView.filter('reviewed');
    }
  }

  addTitleFilter(): void {
    this.dataView.filter(this.filterTitle);
  }

  // ==========================================
  // Selection
  // ==========================================

  handleSelect(event: ThumbnailSelectionEvent): void {
    const sequenceId = event.id;
    const selected = event.selected;
    const isShift = event.isShiftClick;

    if (selected) {
      if (isShift && this.selectedItems.length > 0) {
        // Range selection - find items between last selected and current
        const lastSequenceId =
          this.selectedItems[this.selectedItems.length - 1];
        const lastIndex = this.galleryItems.findIndex(
          (item) => item.sequenceId === lastSequenceId,
        );
        const currentIndex = this.galleryItems.findIndex(
          (item) => item.sequenceId === sequenceId,
        );

        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);

        for (let i = start; i <= end; i++) {
          const item = this.galleryItems[i];
          if (
            item &&
            this.isItemVisible(item) &&
            !this.selectedItems.includes(item.sequenceId)
          ) {
            this.selectedItems.push(item.sequenceId);
          }
        }
      } else {
        if (!this.selectedItems.includes(sequenceId)) {
          this.selectedItems.push(sequenceId);
        }
      }
    } else {
      this.selectedItems = this.selectedItems.filter((id) => id !== sequenceId);
    }
  }

  private isItemVisible(item: GalleryItem): boolean {
    if (!this.dataView.filteredValue) {
      return true;
    }
    return this.dataView.filteredValue.includes(item);
  }

  deselectAll(): void {
    this.selectedItems = [];
  }

  selectAll(): void {
    const visibleItems = this.dataView.filteredValue ?? this.galleryItems;
    this.selectedItems = visibleItems.map((item) => item.sequenceId);
  }
  get selectedFrameCount(): number {
    return this.getSelectedFrameIds().length;
  }

  // ==========================================
  // Navigation
  // ==========================================

  async openItem(item: GalleryItem): Promise<void> {
    const sequence = this.sequenceService
      .sequences()
      .find((s) => s.id === item.sequenceId);
    if (sequence) {
      await this.sequenceService.selectSequence(sequence);
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

  public async markSelectedAsReviewed(reviewed: boolean = true): Promise<void> {
    if (this.selectedItems.length === 0) {
      return;
    }

    const frameIds = this.selectedItems.flatMap(
      (index) => this.galleryItems[index]?.frameIds ?? [],
    );

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

  async getFrameIds(sequence: Sequence): Promise<number[]> {
    const frames = await api.getSequenceFrames(sequence.id);
    return frames.map((f) => f.id);
  }
}
