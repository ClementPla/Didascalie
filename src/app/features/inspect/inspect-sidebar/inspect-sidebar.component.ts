import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';

import { from_hex_to_rgb } from '../../../core/misc/colors';
import { api, SequenceClassification } from '../../../lib/api';

/** A segmentation label that can be shown or hidden. */
export interface SidebarLabel {
  id: number;
  name: string;
  color: string;
}

/** A classification task and the classes it offers. */
export interface SidebarTask {
  name: string;
  classes: string[];
  /** Several classes at once (the project's multilabel task) or just one. */
  multilabel: boolean;
}

/** How the frames of the focused sequence answer one task. */
interface TaskAnswer {
  /** The classes every frame has; empty when they have none, or differ. */
  selected: ReadonlySet<string>;
  /** Frames answer differently, or only some of them answer. */
  mixed: boolean;
}

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

interface SequenceRow {
  id: number;
  name: string;
  /** `name`, lower-cased once for searching. */
  key: string;
  frameCount: number;
  status: SequenceStatus;
  /** Some frame carries an annotation. */
  annotated: boolean;
  thumbnailFrameId: number;
}

/** Rows rendered at once: a project can hold thousands of sequences. */
const PAGE_SIZE = 50;
/** Thumbnails fetched at once; each is a decode on the Rust side. */
const THUMBNAIL_CONCURRENCY = 4;
/** The gallery's default size, so both share the backend's thumbnail cache. */
const THUMBNAIL_SIZE = 256;

/**
 * The inspector's left panel: the labels to draw, the classification of the
 * focused sequence, and the searchable list of sequences, to pick what the
 * focused pane shows or what is compared. It reports what was clicked and is
 * told what is on screen. A sequence is classified here as a whole.
 */
@Component({
  selector: 'app-inspect-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    IconFieldModule,
    InputIconModule,
    InputTextModule,
    TooltipModule,
  ],
  templateUrl: './inspect-sidebar.component.html',
  styleUrl: './inspect-sidebar.component.scss',
})
export class InspectSidebarComponent implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly labels = input<SidebarLabel[]>([]);
  readonly hiddenLabels = input<ReadonlySet<number>>(new Set());
  /** The sequences on screen, one per pane. */
  readonly shownIds = input<number[]>([]);
  /** The sequence a click in the list replaces, and the one classified. */
  readonly focusedId = input<number | null>(null);
  /** The project's classification tasks; none when it has no classification. */
  readonly tasks = input<SidebarTask[]>([]);
  /** The comparison has room for one more sequence. */
  readonly canAdd = input(true);

  readonly labelToggled = output<number>();
  /** Show this sequence in the focused pane. */
  readonly sequenceSelected = output<number>();
  /** Add this sequence to the comparison, or remove it when it is in. */
  readonly sequenceToggled = output<number>();
  /** Add these sequences to the comparison, nearest to the focused one first. */
  readonly sequencesAdded = output<number[]>();

  readonly sequences = signal<SequenceRow[]>([]);
  readonly query = signal('');
  readonly page = signal(0);
  /** Thumbnails loaded so far, by frame id. */
  readonly thumbnails = signal<ReadonlyMap<number, string>>(new Map());

  /** Sequences whose name contains every word of the search. */
  readonly filtered = computed(() => {
    const words = this.query().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return this.sequences();
    return this.sequences().filter((s) => words.every((w) => s.key.includes(w)));
  });
  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.filtered().length / PAGE_SIZE)),
  );
  readonly currentPage = computed(() =>
    Math.min(this.page(), this.pageCount() - 1),
  );
  readonly rows = computed(() => {
    const start = this.currentPage() * PAGE_SIZE;
    return this.filtered().slice(start, start + PAGE_SIZE);
  });
  readonly shown = computed(() => new Set(this.shownIds()));

  /** How the focused sequence is classified; null until it is known. */
  readonly classification = signal<SequenceClassification | null>(null);
  /** A classification is being written. */
  readonly classifying = signal(false);
  readonly focusedName = computed(
    () => this.sequences().find((s) => s.id === this.focusedId())?.name ?? '',
  );
  /** Each task's answer over the focused sequence, by task name. */
  readonly answers = computed(() => {
    const summary = this.classification();
    const byTask = new Map<string, TaskAnswer>();
    for (const task of this.tasks()) {
      const given = (summary?.answers ?? []).filter(
        (a) => a.taskName === task.name,
      );
      const distinct = new Set(
        given.map((a) => JSON.stringify([...a.selectedClasses].sort())),
      );
      const covered = given.reduce((sum, a) => sum + a.frameCount, 0);
      const uniform =
        distinct.size === 1 && covered === (summary?.frameCount ?? 0);
      byTask.set(task.name, {
        selected: new Set(uniform ? given[0].selectedClasses : []),
        mixed: given.length > 0 && !uniform,
      });
    }
    return byTask;
  });

  /** Bumped when the rows change, so thumbnail loads for the old ones stop. */
  private thumbnailRun = 0;
  private destroyed = false;

  constructor() {
    effect(() => {
      const rows = this.rows();
      untracked(() => void this.loadThumbnails(rows));
    });

    effect(() => {
      const id = this.focusedId();
      const classified = this.tasks().length > 0;
      untracked(() => {
        this.classification.set(null);
        if (id !== null && classified) void this.loadClassification(id);
      });
    });

    // Turn to the focused sequence's page, unless a search is narrowing the list.
    effect(() => {
      const id = this.focusedId();
      const all = this.sequences();
      untracked(() => {
        if (id === null || this.query().trim() !== '') return;
        const index = all.findIndex((s) => s.id === id);
        if (index < 0) return;
        this.page.set(Math.floor(index / PAGE_SIZE));
        this.scrollToCurrent();
      });
    });
  }

  async ngOnInit(): Promise<void> {
    try {
      const sequences = await api.getGallerySequences();
      this.sequences.set(
        sequences
          .filter((s) => s.frameCount > 0 && s.firstFrameId != null)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((s) => ({
            id: s.id,
            name: s.name,
            key: s.name.toLowerCase(),
            frameCount: s.frameCount,
            status:
              s.reviewedCount >= s.frameCount
                ? 'reviewed'
                : s.reviewedCount > 0 || s.annotatedCount > 0
                  ? 'annotated'
                  : 'empty',
            annotated: s.reviewedCount > 0 || s.annotatedCount > 0,
            thumbnailFrameId: s.firstFrameId!,
          })),
      );
    } catch (error) {
      console.error('Failed to list the sequences to inspect:', error);
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.thumbnailRun++;
  }

  search(query: string): void {
    this.query.set(query);
    this.page.set(0);
  }

  turnPage(delta: number): void {
    this.page.set(
      Math.max(0, Math.min(this.currentPage() + delta, this.pageCount() - 1)),
    );
    this.host.nativeElement.querySelector('.rows')?.scrollTo({ top: 0 });
  }

  /** A click on a row: it goes to the focused pane; with Ctrl (or ⌘) it joins
   *  or leaves the comparison; with Shift, so does the range up to it. */
  pick(row: SequenceRow, event: MouseEvent): void {
    if (event.ctrlKey || event.metaKey) {
      this.sequenceToggled.emit(row.id);
    } else if (event.shiftKey) {
      const listed = this.filtered();
      const from = listed.findIndex((s) => s.id === this.focusedId());
      const to = listed.indexOf(row);
      if (from < 0 || from === to) {
        this.sequencesAdded.emit([row.id]);
        return;
      }
      const step = to > from ? 1 : -1;
      const ids: number[] = [];
      for (let i = from + step; i !== to + step; i += step) {
        ids.push(listed[i].id);
      }
      this.sequencesAdded.emit(ids);
    } else {
      this.sequenceSelected.emit(row.id);
    }
  }

  /** The last pane cannot be removed; a full comparison takes no more. */
  canToggle(id: number): boolean {
    return this.shown().has(id) ? this.shownIds().length > 1 : this.canAdd();
  }

  /** Every frame of sequence `id` was marked reviewed, or unmarked. */
  setReviewed(id: number, reviewed: boolean): void {
    this.sequences.update((rows) =>
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              status: reviewed
                ? 'reviewed'
                : row.annotated
                  ? 'annotated'
                  : 'empty',
            }
          : row,
      ),
    );
  }

  isHidden(id: number): boolean {
    return this.hiddenLabels().has(id);
  }

  isSelected(task: SidebarTask, name: string): boolean {
    return this.answers().get(task.name)?.selected.has(name) ?? false;
  }

  isMixed(task: SidebarTask): boolean {
    return this.answers().get(task.name)?.mixed ?? false;
  }

  /** Answer `task` with `name` on every frame of the focused sequence. A
   *  one-class task switches to it, or drops it; a multilabel task toggles it. */
  async classify(task: SidebarTask, name: string): Promise<void> {
    const id = this.focusedId();
    if (id === null || this.classifying()) return;
    const current = this.answers().get(task.name)?.selected ?? new Set<string>();
    let next: string[];
    if (task.multilabel) {
      const selected = new Set(current);
      if (!selected.delete(name)) selected.add(name);
      // In the task's own order, whatever order they were clicked in.
      next = task.classes.filter((c) => selected.has(c));
    } else {
      next = current.has(name) ? [] : [name];
    }

    this.classifying.set(true);
    try {
      await api.saveSequenceClassification(id, task.name, next, task.multilabel);
      await this.loadClassification(id);
    } catch (error) {
      console.error('Failed to classify the sequence:', error);
    } finally {
      this.classifying.set(false);
    }
  }

  private async loadClassification(sequenceId: number): Promise<void> {
    try {
      const summary = await api.getSequenceClassification(sequenceId);
      // The focus may have moved on while this was loading.
      if (sequenceId === this.focusedId()) this.classification.set(summary);
    } catch (error) {
      console.error('Failed to load the classification of the sequence:', error);
    }
  }

  /** Black or white, whichever reads better on `color`. */
  textOn(color: string): string {
    const [r, g, b] = from_hex_to_rgb(color);
    if ([r, g, b].some(Number.isNaN)) return '#fff';
    // Perceived brightness (ITU-R BT.601), 0..255.
    return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#000' : '#fff';
  }

  private async loadThumbnails(rows: readonly SequenceRow[]): Promise<void> {
    const run = ++this.thumbnailRun;
    const queue = rows
      .map((r) => r.thumbnailFrameId)
      .filter((id) => !this.thumbnails().has(id));

    const worker = async () => {
      for (;;) {
        const frameId = queue.shift();
        if (frameId === undefined || run !== this.thumbnailRun) return;
        try {
          const { imageBase64 } = await api.getFrameThumbnail(
            frameId,
            THUMBNAIL_SIZE,
          );
          if (this.destroyed) return;
          this.thumbnails.update((map) => new Map(map).set(frameId, imageBase64));
        } catch (error) {
          console.error(`Failed to load the thumbnail of frame ${frameId}:`, error);
        }
      }
    };
    await Promise.all(Array.from({ length: THUMBNAIL_CONCURRENCY }, worker));
  }

  private scrollToCurrent(): void {
    setTimeout(() => {
      this.host.nativeElement
        .querySelector('.row.is-current')
        ?.scrollIntoView({ block: 'nearest' });
    });
  }
}
