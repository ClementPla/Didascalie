import { AfterViewInit, ChangeDetectorRef, Component, ElementRef, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { PanelModule } from 'primeng/panel';
import { DataViewModule } from 'primeng/dataview';
import { ButtonModule } from 'primeng/button';
import { KnobModule } from 'primeng/knob';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SelectModule } from 'primeng/select';
import { MultiSelectModule } from 'primeng/multiselect';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { SliderModule } from 'primeng/slider';
import { TooltipModule } from 'primeng/tooltip';

import { ProjectService } from '../../services/project/project.service';
import { SequenceService } from '../../services/sequence.service';
import { LabelsService } from '../../services/labels/labels.service';
import { GalleryService, NO_CLASS } from './gallery.service';
import { BatchAnnotationService } from '../../services/labels/batch-annotation.service';
import { UIStateService } from '../../services/uistate.service';
import { NotificationService } from '../../services/notification.service';
import { WorklistService } from '../../services/worklist.service';
import { api } from '../../lib/api';

import {
  GalleryElementComponent,
  ThumbnailSelectionEvent,
} from './gallery-element/gallery-element.component';
import { LabelledSwitchComponent } from '../../shared/generics/labelled-switch/labelled-switch.component';
import { Router } from '@angular/router';
import {
  InspectionService,
  MAX_INSPECT_PANES,
} from '../inspect/inspection.service';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

/** Which page to show once the filters are applied: the one holding the
 *  sequence open in the editor, the first, or the one already shown. */
type PageMode = 'locate' | 'top' | 'keep';

interface GalleryItem {
  frameIds: number[];
  status: SequenceStatus;
  title: string;
  sequenceId: number;
  sequenceName: string;
  frameCount: number;
  thumbnailFrameId: number;
  /** Fraction of frames reviewed, 0..1. */
  progress: number;
  /** Frames carrying an annotation: a sequence that stops being reviewed falls
   *  back to 'annotated'. */
  annotatedCount: number;
  hasKeypoints: boolean;
  /** Classification task -> the classes at least one frame was given. */
  classes: Record<string, string[] | undefined>;
  /** Regression task -> the mean of the values its frames were given. */
  regressions: Record<string, number | undefined>;
}

interface SortOption {
  label: string;
  value: string;
}

/** A classification task as the filters list it. */
interface ClassFilterRow {
  name: string;
  /** In the task's order: the rank a "by class" sort goes by. */
  classes: string[];
  options: { label: string; value: string }[];
}

/** A regression task as the filters list it, with the span of its slider. */
interface RegressionFilterRow {
  name: string;
  min: number;
  max: number;
  step: number;
}

const BASE_SORT_OPTIONS: SortOption[] = [
  { label: 'Name (A-Z)', value: 'name-asc' },
  { label: 'Name (Z-A)', value: 'name-desc' },
  { label: 'Most frames', value: 'frames-desc' },
  { label: 'Fewest frames', value: 'frames-asc' },
  { label: 'Most progress', value: 'progress-desc' },
  { label: 'Least progress', value: 'progress-asc' },
];

// Sorts by one of the project's tasks are `kind:task name`.
const SORT_BY_CLASS = 'class:';
const SORT_BY_VALUE_ASC = 'value-asc:';
const SORT_BY_VALUE_DESC = 'value-desc:';

/** The model of a class filter nothing is picked in. One array for all: a
 *  new one on every change detection would have `ngModel` write it back to
 *  the control, which schedules a change detection, without end. */
const NO_CLASSES: string[] = [];

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
    LabelledSwitchComponent,
    SelectButtonModule,
    SelectModule,
    MultiSelectModule,
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
  projectService = inject(ProjectService);
  sequenceService = inject(SequenceService);
  labelsService = inject(LabelsService);
  galleryService = inject(GalleryService);
  private batchAnnotationService = inject(BatchAnnotationService);
  private uiState = inject(UIStateService);
  private notifications = inject(NotificationService);
  private router = inject(Router);
  private inspection = inject(InspectionService);
  private cdr = inject(ChangeDetectorRef);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);
  private worklist = inject(WorklistService);

  autoRefresh = false;

  refreshInterval = 3000;
  percentageBeforeRefresh = 0;
  intervalFunction: ReturnType<typeof setInterval> | undefined;

  galleryItems: GalleryItem[] = [];
  filteredItems: GalleryItem[] = [];
  /** Most sequences the inspector compares at once. */
  readonly maxInspected = MAX_INSPECT_PANES;

  maxFrameCount = 0;

  batchMulticlassChoices: (string | null)[] = [];
  batchMultilabelChoices: string[] = [];

  readonly statusOptions: { label: string; value: SequenceStatus }[] = [
    { label: 'Not started', value: 'empty' },
    { label: 'In progress', value: 'annotated' },
    { label: 'Reviewed', value: 'reviewed' },
  ];

  /** The fixed sorts, then one per classification task and two per
   *  regression value of the project. */
  sortOptions: SortOption[] = BASE_SORT_OPTIONS;
  /** The project's classification tasks, when classification is on. */
  classRows: ClassFilterRow[] = [];
  /** The project's regression values that have a span to filter on. */
  regressionRows: RegressionFilterRow[] = [];

  readonly keypointFilterOptions = [
    { label: 'All', value: 'all' as const },
    { label: 'With keypoints', value: 'with' as const },
    { label: 'Without', value: 'without' as const },
  ];

  readonly layoutOptions = [
    { icon: 'pi pi-th-large', value: 'grid' as const, label: 'Grid view' },
    { icon: 'pi pi-bars', value: 'list' as const, label: 'List view' },
  ];

  /** Ticked sequences; on the service so they survive a trip to the editor. */
  get selectedItems(): number[] {
    return this.galleryService.selectedIds;
  }
  set selectedItems(ids: number[]) {
    this.galleryService.selectedIds = ids;
  }

  /** The sequence open in the editor, marked in the gallery. */
  get currentSequenceId(): number | null {
    return this.sequenceService.currentSequence()?.id ?? null;
  }

  // The component is rebuilt on every visit (no route reuse), so this is the
  // one load per visit.
  async ngAfterViewInit(): Promise<void> {
    this.initBatchChoices();
    await this.refresh('locate');
  }

  ngOnDestroy(): void {
    if (this.intervalFunction) {
      clearInterval(this.intervalFunction);
    }
  }

  // ── Initialization ───────────────────────────────────────────────────────

  private initBatchChoices(): void {
    this.batchMulticlassChoices =
      this.labelsService.listClassificationTasks.map(() => null);
    this.batchMultilabelChoices = [];
  }

  // ── Refresh & Auto-refresh ───────────────────────────────────────────────

  async refresh(page: PageMode = 'keep'): Promise<void> {
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
    if (!this.galleryService.frameRangeInitialized()) {
      this.galleryService.frameCountRange.set([0, this.maxFrameCount]);
      this.galleryService.frameRangeInitialized.set(true);
    }

    this.buildAnswerControls();

    // Ticked sequences that no longer exist.
    const known = new Set(this.galleryItems.map((item) => item.sequenceId));
    this.selectedItems = this.selectedItems.filter((id) => known.has(id));

    this.applyFilters(page);

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

  // ── Load Gallery Items ───────────────────────────────────────────────────

  async getItems(): Promise<GalleryItem[]> {
    this.uiState.setLoading(true, 'Loading gallery items...');
    try {
      // Two queries in total, not one per sequence.
      const [sequences, frameIdsBySequence, answers] = await Promise.all([
        api.getGallerySequences(),
        api.getAllFrameIdsBySequence(),
        api.getGalleryAnswers(),
      ]);
      const answersOf = new Map(answers.map((a) => [a.sequenceId, a]));

      // What the launcher shows about this project.
      const listed = sequences.filter((seq) => seq.frameCount > 0);
      this.projectService.updateOpenProjectStats({
        sequences: listed.length,
        frames: listed.reduce((sum, seq) => sum + seq.frameCount, 0),
        reviewedFrames: listed.reduce((sum, seq) => sum + seq.reviewedCount, 0),
      });

      return listed
        .map((seq) => ({
          sequenceId: seq.id,
          sequenceName: seq.name,
          title: seq.name,
          frameCount: seq.frameCount,
          thumbnailFrameId: seq.firstFrameId!,
          status: this.computeStatus(
            seq.reviewedCount,
            seq.annotatedCount,
            seq.frameCount,
          ),
          progress:
            seq.frameCount > 0 ? seq.reviewedCount / seq.frameCount : 0,
          annotatedCount: seq.annotatedCount,
          frameIds: frameIdsBySequence[seq.id] ?? [],
          hasKeypoints: seq.hasKeypoints,
          classes: answersOf.get(seq.id)?.classes ?? {},
          regressions: answersOf.get(seq.id)?.regressions ?? {},
        }));
    } catch (error) {
      console.error('Failed to load gallery items:', error);
      this.notifications.error(
        'Failed to load gallery',
        error instanceof Error ? error.message : String(error)
      );
      return [];
    } finally {
      this.uiState.endLoading();
    }
  }

  private computeStatus(
    reviewed: number,
    annotated: number,
    total: number,
  ): SequenceStatus {
    if (total > 0 && reviewed >= total) return 'reviewed';
    if (reviewed > 0 || annotated > 0) return 'annotated';
    return 'empty';
  }

  // ── Classification & regression controls ─────────────────────────────────

  /** List what the project's tasks can be filtered and sorted by. */
  private buildAnswerControls(): void {
    const config = this.projectService.config();

    const tasks = this.projectService.isClassification()
      ? [
          ...this.labelsService.listClassificationTasks.map((t) => ({
            name: t.taskName,
            classes: t.classLabels,
          })),
          ...(this.labelsService.multiLabelTask
            ? [
                {
                  name: this.labelsService.multiLabelTask.taskName,
                  classes: this.labelsService.multiLabelTask.taskLabels,
                },
              ]
            : []),
        ]
      : [];
    this.classRows = tasks.map((task) => ({
      name: task.name,
      classes: [...task.classes],
      options: [
        ...task.classes.map((c) => ({ label: c, value: c })),
        { label: 'Unanswered', value: NO_CLASS },
      ],
    }));

    const values = config.regression_enabled ? (config.regression_tasks ?? []) : [];
    this.regressionRows = [];
    for (const task of values) {
      // A missing bound comes from the values entered so far.
      const entered = this.galleryItems
        .map((item) => item.regressions[task.name])
        .filter((v): v is number => v !== undefined);
      if (entered.length === 0 && (task.min == null || task.max == null)) continue;
      const integer = task.dtype === 'int32';
      let min = task.min ?? Math.min(...entered);
      let max = task.max ?? Math.max(...entered);
      // A sequence of several frames holds their mean, which is not whole.
      if (integer) [min, max] = [Math.floor(min), Math.ceil(max)];
      if (!(max > min)) continue;
      const step = integer ? 1 : 10 ** Math.floor(Math.log10((max - min) / 100));
      this.regressionRows.push({ name: task.name, min, max, step });
    }

    this.sortOptions = [
      ...BASE_SORT_OPTIONS,
      ...this.classRows.map((row) => ({
        label: `${row.name} (by class)`,
        value: SORT_BY_CLASS + row.name,
      })),
      ...values.flatMap((task) => [
        { label: `${task.name} (lowest first)`, value: SORT_BY_VALUE_ASC + task.name },
        { label: `${task.name} (highest first)`, value: SORT_BY_VALUE_DESC + task.name },
      ]),
    ];
    // A sort by a task that was renamed, deleted or switched off.
    const sortKey = this.galleryService.sortKey();
    if (!this.sortOptions.some((option) => option.value === sortKey)) {
      this.galleryService.sortKey.set('name-asc');
    }
  }

  setClassFilter(task: string, classes: string[]): void {
    this.galleryService.classFilters.update((filters) => ({
      ...filters,
      [task]: classes ?? [],
    }));
    this.applyFilters();
  }

  /** The classes picked for a task; the same array until the filter changes. */
  classFilter(row: ClassFilterRow): string[] {
    return this.galleryService.classFilters()[row.name] ?? NO_CLASSES;
  }

  /** The arrays the regression sliders are bound to, by task. */
  private readonly rangeModels = new Map<string, number[]>();

  /**
   * The span shown on a regression slider: the filter, or the whole range.
   * The same array until the span changes, for the reason given on
   * `NO_CLASSES`.
   */
  regressionRange(row: RegressionFilterRow): number[] {
    const [low, high] =
      this.galleryService.regressionRanges()[row.name] ?? [row.min, row.max];
    const model = this.rangeModels.get(row.name);
    if (model && model[0] === low && model[1] === high) return model;
    const fresh = [low, high];
    this.rangeModels.set(row.name, fresh);
    return fresh;
  }

  /** The slider moved. Applied when it is released (`applyFilters`). */
  setRegressionRange(row: RegressionFilterRow, range: number[]): void {
    const [low, high] = range;
    this.galleryService.regressionRanges.update((ranges) => {
      const next = { ...ranges };
      // The whole range is no filter: sequences without a value are listed.
      if (low <= row.min && high >= row.max) delete next[row.name];
      else next[row.name] = [low, high];
      return next;
    });
  }

  /** The class filters in use, limited to the tasks the project still has. */
  private activeClassFilters(): { row: ClassFilterRow; wanted: string[] }[] {
    if (!this.galleryService.showAdvancedFilters()) return [];
    const filters = this.galleryService.classFilters();
    return this.classRows
      .map((row) => ({ row, wanted: filters[row.name] ?? [] }))
      .filter((f) => f.wanted.length > 0);
  }

  /** The regression filters in use, limited to the values the project has. */
  private activeRegressionFilters(): { row: RegressionFilterRow; range: [number, number] }[] {
    if (!this.galleryService.showAdvancedFilters()) return [];
    const ranges = this.galleryService.regressionRanges();
    return this.regressionRows.flatMap((row) => {
      const range = ranges[row.name];
      return range ? [{ row, range }] : [];
    });
  }

  // ── Filtering & Sorting ──────────────────────────────────────────────────

  applyFilters(page: PageMode = 'top'): void {
    let items = [...this.galleryItems];

    const query = this.galleryService.filterTitle().trim().toLowerCase();
    if (query) {
      items = items.filter((item) => item.title.toLowerCase().includes(query));
    }

    if (this.galleryService.selectedStatuses().length > 0) {
      items = items.filter((item) =>
        this.galleryService.selectedStatuses().includes(item.status),
      );
    }

    if (this.galleryService.keypointFilter() !== 'all') {
      const wantKeypoints = this.galleryService.keypointFilter() === 'with';
      items = items.filter((item) => item.hasKeypoints === wantKeypoints);
    }

    if (this.galleryService.showAdvancedFilters()) {
      const [min, max] = this.galleryService.frameCountRange();
      items = items.filter(
        (item) => item.frameCount >= min && item.frameCount <= max,
      );
    }

    // Any of the wanted classes of a task, and every filtered task.
    for (const { row, wanted } of this.activeClassFilters()) {
      items = items.filter((item) => {
        const given = item.classes[row.name] ?? [];
        return wanted.some((c) =>
          c === NO_CLASS ? given.length === 0 : given.includes(c),
        );
      });
    }
    for (const { row, range } of this.activeRegressionFilters()) {
      items = items.filter((item) => {
        const value = item.regressions[row.name];
        return value !== undefined && value >= range[0] && value <= range[1];
      });
    }

    items.sort((a, b) => this.compareItems(a, b));
    this.filteredItems = items;
    // The editor's next/previous follows what is listed here.
    this.worklist.set(
      items.map((item) => item.sequenceId),
      this.describeFilters(),
    );
    this.placePage(page);
    this.cdr.markForCheck();
  }

  private placePage(page: PageMode): void {
    const rows = this.galleryService.itemPerPage();
    const pageOf = (index: number) => Math.floor(index / rows) * rows;
    const count = this.filteredItems.length;

    if (page === 'locate') {
      const index = this.filteredItems.findIndex(
        (item) => item.sequenceId === this.currentSequenceId,
      );
      if (index >= 0) {
        this.galleryService.first.set(pageOf(index));
        this.scrollToCurrent();
        return;
      }
      // Not listed: stay on the page shown last.
      page = 'keep';
    }

    if (page === 'top') {
      this.galleryService.first.set(0);
      this.scrollToTop();
      return;
    }

    // Keep, within bounds: the list may have shrunk.
    if (this.galleryService.first() >= count) {
      this.galleryService.first.set(count > 0 ? pageOf(count - 1) : 0);
    }
  }

  onPage(first: number): void {
    this.galleryService.first.set(first);
    this.scrollToTop();
  }

  private scrollToCurrent(): void {
    // After the page renders.
    setTimeout(() => {
      this.host.nativeElement
        .querySelector('.is-current')
        ?.scrollIntoView({ block: 'center' });
    });
  }

  private scrollToTop(): void {
    setTimeout(() => {
      this.host.nativeElement
        .querySelector('.gallery-scroll')
        ?.scrollTo({ top: 0 });
    });
  }

  /** The active filters and sort in words, for the editor's Sequences panel. */
  private describeFilters(): string {
    const parts: string[] = [];
    const query = this.galleryService.filterTitle().trim();
    if (query) parts.push(`"${query}"`);
    const statuses = this.galleryService.selectedStatuses();
    if (statuses.length > 0) {
      parts.push(
        this.statusOptions
          .filter((option) => statuses.includes(option.value))
          .map((option) => option.label)
          .join(' / '),
      );
    }
    const keypoints = this.galleryService.keypointFilter();
    if (keypoints !== 'all') {
      parts.push(keypoints === 'with' ? 'With keypoints' : 'Without keypoints');
    }
    if (this.galleryService.showAdvancedFilters()) {
      const [min, max] = this.galleryService.frameCountRange();
      if (min > 0 || max < this.maxFrameCount) parts.push(`${min}-${max} frames`);
    }
    for (const { row, wanted } of this.activeClassFilters()) {
      const names = wanted.map((c) => (c === NO_CLASS ? 'unanswered' : c));
      parts.push(`${row.name}: ${names.join(' / ')}`);
    }
    for (const { row, range } of this.activeRegressionFilters()) {
      parts.push(`${row.name} ${formatValue(range[0])}-${formatValue(range[1])}`);
    }
    const sortKey = this.galleryService.sortKey();
    if (sortKey !== 'name-asc') {
      const sort = this.sortOptions.find((option) => option.value === sortKey);
      if (sort) parts.push(sort.label);
    }
    return parts.join(' · ');
  }

  private compareItems(a: GalleryItem, b: GalleryItem): number {
    const sortKey = this.galleryService.sortKey();
    const byName = () => a.title.localeCompare(b.title);

    // By a regression value; the sequences without one come last either way.
    for (const [prefix, direction] of [
      [SORT_BY_VALUE_ASC, 1],
      [SORT_BY_VALUE_DESC, -1],
    ] as const) {
      if (!sortKey.startsWith(prefix)) continue;
      const task = sortKey.slice(prefix.length);
      const [va, vb] = [a.regressions[task], b.regressions[task]];
      if (va === undefined || vb === undefined) {
        return va === vb ? byName() : va === undefined ? 1 : -1;
      }
      return direction * (va - vb) || byName();
    }

    // By class, in the order the task lists them; unanswered last.
    if (sortKey.startsWith(SORT_BY_CLASS)) {
      const task = sortKey.slice(SORT_BY_CLASS.length);
      const order = this.classRows.find((row) => row.name === task)?.classes ?? [];
      const rank = (item: GalleryItem) => {
        const ranks = (item.classes[task] ?? [])
          .map((c) => order.indexOf(c))
          .filter((i) => i >= 0);
        return ranks.length > 0 ? Math.min(...ranks) : Number.MAX_SAFE_INTEGER;
      };
      return rank(a) - rank(b) || byName();
    }

    switch (sortKey) {
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
    this.galleryService.filterTitle.set('');
    this.galleryService.selectedStatuses.set([]);
    this.galleryService.keypointFilter.set('all');
    this.galleryService.sortKey.set('name-asc');
    this.galleryService.frameCountRange.set([0, this.maxFrameCount]);
    this.galleryService.classFilters.set({});
    this.galleryService.regressionRanges.set({});
    this.applyFilters();
  }

  get hasActiveFilters(): boolean {
    const rangeNarrowed =
      this.galleryService.showAdvancedFilters() &&
      (this.galleryService.frameCountRange()[0] > 0 ||
        this.galleryService.frameCountRange()[1] < this.maxFrameCount);
    return (
      this.galleryService.filterTitle().trim() !== '' ||
      this.galleryService.selectedStatuses().length > 0 ||
      this.galleryService.keypointFilter() !== 'all' ||
      rangeNarrowed ||
      this.activeClassFilters().length > 0 ||
      this.activeRegressionFilters().length > 0
    );
  }

  // ── Selection ────────────────────────────────────────────────────────────

  handleSelect(event: ThumbnailSelectionEvent): void {
    const { id: sequenceId, selected, isShiftClick } = event;

    if (!selected) {
      this.selectedItems = this.selectedItems.filter((id) => id !== sequenceId);
      return;
    }

    // A range follows the visible order.
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

  // ── Navigation ───────────────────────────────────────────────────────────

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

  inspectItem(item: GalleryItem): void {
    void this.inspection.open([item.sequenceId]);
  }

  /** Compare the selected sequences in the inspector, in listed order. */
  inspectSelected(): void {
    const selected = new Set(this.selectedItems);
    const ids = this.filteredItems
      .map((item) => item.sequenceId)
      .filter((id) => selected.has(id));
    // A selection made before the filters changed may no longer be listed.
    void this.inspection.open(ids.length > 0 ? ids : this.selectedItems);
  }

  async pairItem(item: GalleryItem): Promise<void> {
    // The pairing panel works on the app's current sequence.
    if (await this.inspection.shareSequence(item.sequenceId)) {
      await this.router.navigate(['/registration']);
    } else {
      console.error(`Failed to find sequence with ID ${item.sequenceId}`);
    }
  }

  // ── Batch Annotation ─────────────────────────────────────────────────────

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

  /** Mark a sequence reviewed or not, from the list view. Local state is
   *  updated without a reload. */
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

      item.progress = event.reviewed ? 1 : 0;
      item.status = this.computeStatus(
        event.reviewed ? item.frameCount : 0,
        item.annotatedCount,
        item.frameCount,
      );
      this.applyFilters('keep');
    } catch (error) {
      console.error('Failed to mark sequence as reviewed:', error);
    }
  }

  private resetBatchChoices(): void {
    this.batchMulticlassChoices =
      this.labelsService.listClassificationTasks.map(() => null);
    this.batchMultilabelChoices = [];
  }

  // ── Getters for Template ─────────────────────────────────────────────────

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

/** A regression bound as the filter description shows it. */
function formatValue(value: number): string {
  return String(Number(value.toPrecision(4)));
}
