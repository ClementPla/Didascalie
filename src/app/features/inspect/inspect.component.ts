import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  NgZone,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChildren,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ToggleButtonModule } from 'primeng/togglebutton';
import { TooltipModule } from 'primeng/tooltip';

import { buildLabelPalette } from '../../core/misc/colors';
import { IOService } from '../../services/io.service';
import { LabelsService } from '../../services/labels/labels.service';
import { ProjectService } from '../../services/project/project.service';
import { SequenceService } from '../../services/sequence.service';
import { UIStateService } from '../../services/uistate.service';
import { OverlayLabel } from './frame-cache';
import {
  InspectPaneComponent,
  RelativeView,
} from './inspect-pane/inspect-pane.component';
import {
  InspectSidebarComponent,
  SidebarTask,
} from './inspect-sidebar/inspect-sidebar.component';
import { InspectionService, MAX_INSPECT_PANES } from './inspection.service';

/** Decoded frames held across all panes, in bytes; split evenly between them. */
const CACHE_BUDGET_BYTES = 768 * 1024 ** 2;
/** How often the achieved frame rate is re-measured while playing. */
const RATE_WINDOW_MS = 1000;

interface LegendLabel {
  id: number;
  name: string;
  color: string;
  palette: number[];
}

/**
 * The "Inspect sequence" panel: plays sequences back like videos, labels on
 * top, to review them without the editor's tools.
 *
 * One clock (`frame`) drives every pane, so sequences compared side by side
 * stay on the same frame index; a shorter one holds its last frame. The clock
 * only advances once every pane has the next frame decoded: when the disk or
 * the decoder cannot keep up, playback slows down rather than skipping frames
 * or letting the panes drift apart.
 */
@Component({
  selector: 'app-inspect',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    ButtonModule,
    InputTextModule,
    SelectModule,
    SliderModule,
    ToggleButtonModule,
    TooltipModule,
    InspectPaneComponent,
    InspectSidebarComponent,
  ],
  templateUrl: './inspect.component.html',
  styleUrl: './inspect.component.scss',
})
export class InspectComponent implements OnInit, OnDestroy {
  readonly inspection = inject(InspectionService);
  private readonly sequences = inject(SequenceService);
  private readonly labelsService = inject(LabelsService);
  private readonly project = inject(ProjectService);
  private readonly io = inject(IOService);
  private readonly uiState = inject(UIStateService);
  private readonly zone = inject(NgZone);

  readonly panes = viewChildren(InspectPaneComponent);

  /** The sequences to show are known (see `ngOnInit`). */
  readonly ready = signal(false);
  /** The clock: the frame index every pane shows. */
  readonly frame = signal(0);
  readonly playing = signal(false);
  /** Playback is waiting for a pane to decode the next frame. */
  readonly buffering = signal(false);
  /** Frames per second actually shown, measured while playing. */
  readonly achievedFps = signal<number | null>(null);

  readonly sequenceIds = this.inspection.sequenceIds;
  readonly multiple = computed(() => this.sequenceIds().length > 1);
  readonly canAddPane = computed(
    () => this.sequenceIds().length < MAX_INSPECT_PANES,
  );
  /** Timeline length: the longest sequence on screen. */
  readonly length = computed(() =>
    Math.max(1, ...this.panes().map((p) => p.frameCount())),
  );
  /**
   * The frames playback runs over, first and last included: the whole
   * timeline, narrowed by the range the user set (see `InspectionService`).
   */
  readonly range = computed<readonly [number, number]>(() => {
    const end = this.length() - 1;
    const first = Math.min(Math.max(this.inspection.rangeStart() ?? 0, 0), end);
    const last = Math.min(Math.max(this.inspection.rangeEnd() ?? end, first), end);
    return [first, last];
  });
  readonly hasRange = computed(
    () =>
      this.inspection.rangeStart() !== null ||
      this.inspection.rangeEnd() !== null,
  );
  /**
   * What the panes buffer: the range as the user set it, not clamped to the
   * timeline. Each pane clamps to its own sequence, and the timeline's length
   * is not known while they load.
   */
  readonly paneRange = computed<readonly [number, number] | null>(() =>
    this.hasRange()
      ? [
          this.inspection.rangeStart() ?? 0,
          this.inspection.rangeEnd() ?? Number.MAX_SAFE_INTEGER,
        ]
      : null,
  );
  /** The sequence the focused pane shows: the one a pick in the list replaces. */
  readonly focusedSequenceId = computed(
    () => this.sequenceIds()[this.inspection.focused()] ?? null,
  );
  readonly columns = computed(() =>
    Math.ceil(Math.sqrt(this.sequenceIds().length)),
  );
  readonly paneBudget = computed(
    () => CACHE_BUDGET_BYTES / Math.max(1, this.sequenceIds().length),
  );

  /** Playback is falling short of the requested rate by a visible margin. */
  readonly isSlow = computed(() => {
    const achieved = this.achievedFps();
    return (
      this.playing() &&
      achieved !== null &&
      achieved < this.inspection.fps() * 0.9
    );
  });

  /** Sequences that can still be added to the comparison. */
  readonly addableSequences = computed(() => {
    const shown = new Set(this.sequenceIds());
    return this.sequences.sequences().filter((s) => !shown.has(s.id));
  });
  /** Bound to the "add a sequence" picker, which is cleared after each pick. */
  readonly sequenceToAdd = signal<number | null>(null);

  /** The project's segmentation labels, in drawing order (bottom to top). */
  readonly legend = signal<LegendLabel[]>([]);
  readonly hiddenLabels = signal<ReadonlySet<number>>(new Set());
  /** The project's classification tasks, to classify a sequence as a whole. */
  readonly tasks = signal<SidebarTask[]>([]);
  readonly overlayLabels = computed<OverlayLabel[]>(() => {
    const hidden = this.hiddenLabels();
    return this.legend()
      .filter((l) => !hidden.has(l.id))
      .map(({ id, palette }) => ({ id, palette }));
  });

  readonly fpsOptions = [1, 2, 5, 10, 15, 25, 30, 60].map((value) => ({
    label: `${value} fps`,
    value,
  }));

  private rafId: number | null = null;
  /** When the clock last advanced (`performance.now()` time base). */
  private lastAdvance = 0;
  private rateWindowStart = 0;
  private rateWindowFrames = 0;

  constructor() {
    // A sequence was swapped for a shorter one, or the range moved: stay on
    // the frames being played. Waits for every pane to know its length, so a
    // frame to open on is not clamped against sequences that have not loaded
    // yet.
    effect(() => {
      const panes = this.panes();
      if (panes.length === 0) return;
      if (panes.some((p) => p.status() === 'loading')) return;
      const [first, last] = this.range();
      untracked(() => {
        if (this.frame() > last) this.frame.set(last);
        else if (this.frame() < first) this.frame.set(first);
      });
    });
  }

  async ngOnInit(): Promise<void> {
    // The inspector reads the project, not the editor's canvas: an edit still
    // waiting for its autosave would otherwise be missing from playback.
    await this.io.saveIfDirty();
    if (this.sequences.sequences().length === 0) {
      await this.sequences.loadSequences();
    }

    this.legend.set(
      this.labelsService.listSegmentationLabels.map((label) => ({
        id: label.id,
        name: label.label,
        color: label.color,
        palette: Array.from(buildLabelPalette(label.color, label.shades)),
      })),
    );

    if (this.project.isClassification()) {
      const multilabel = this.labelsService.multiLabelTask;
      this.tasks.set(
        [
          ...this.labelsService.listClassificationTasks.map((task) => ({
            name: task.taskName,
            classes: [...task.classLabels],
            multilabel: false,
          })),
          ...(multilabel
            ? [
                {
                  name: multilabel.taskName,
                  classes: [...multilabel.taskLabels],
                  multilabel: true,
                },
              ]
            : []),
        ].filter((task) => task.classes.length > 0),
      );
    }

    this.resolveSequences();
    this.frame.set(Math.max(0, this.inspection.startFrame));
    this.inspection.startFrame = 0;
    this.ready.set(true);
    this.shareFocused();
  }

  ngOnDestroy(): void {
    this.pause();
  }

  /**
   * Decide what to show on arrival. Sequences sent through
   * `InspectionService.open()` are shown as asked. Otherwise the panel comes
   * back as it was left — except that its focused pane follows the app's
   * current sequence, which may have moved in the editor meanwhile.
   */
  private resolveSequences(): void {
    const known = new Set(this.sequences.sequences().map((s) => s.id));
    const requested = this.inspection.takeRequest();
    let ids = this.sequenceIds().filter((id) => known.has(id));
    let focused = Math.min(this.inspection.focused(), ids.length - 1);

    const current = this.sequences.currentSequence()?.id;
    if (current !== undefined && (ids.length === 0 || !requested)) {
      const at = ids.indexOf(current);
      if (ids.length === 0) {
        ids = [current];
      } else if (at >= 0) {
        focused = at;
      } else {
        ids = ids.map((id, i) => (i === focused ? current : id));
      }
    }

    this.sequenceIds.set(ids);
    this.inspection.focused.set(Math.max(0, focused));
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  togglePlay(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  play(): void {
    const [first, last] = this.range();
    if (this.playing() || last <= first) return;
    // Pressing play at the end of a sequence that does not loop restarts it.
    if (!this.inspection.loop() && this.frame() >= last) {
      this.frame.set(first);
    }
    this.playing.set(true);
    this.achievedFps.set(null);
    const now = performance.now();
    this.lastAdvance = now;
    this.rateWindowStart = now;
    this.rateWindowFrames = 0;
    // One callback per display refresh: keep it out of change detection.
    // Advancing writes `frame`, and that alone repaints what depends on it.
    this.zone.runOutsideAngular(() => {
      this.rafId = requestAnimationFrame(this.tick);
    });
  }

  pause(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.playing.set(false);
    this.buffering.set(false);
  }

  private readonly tick = (now: number): void => {
    if (!this.playing()) return;
    this.rafId = requestAnimationFrame(this.tick);

    const interval = 1000 / this.inspection.fps();
    if (now - this.lastAdvance < interval) return;

    const next = this.frameAfter(this.frame(), 1);
    if (next === null) {
      this.pause();
      return;
    }
    if (!this.panes().every((p) => p.isReady(next))) {
      this.buffering.set(true);
      return; // try again on the next refresh
    }
    this.buffering.set(false);

    // Keep the cadence when on time; after a stall, restart it from now
    // instead of rushing through frames to catch up.
    this.lastAdvance =
      now - this.lastAdvance > 2 * interval ? now : this.lastAdvance + interval;
    this.frame.set(next);

    this.rateWindowFrames++;
    if (now - this.rateWindowStart >= RATE_WINDOW_MS) {
      this.achievedFps.set(
        (this.rateWindowFrames * 1000) / (now - this.rateWindowStart),
      );
      this.rateWindowStart = now;
      this.rateWindowFrames = 0;
    }
  };

  /** The frame `step` away from `from` in the played range, wrapping when
   *  looping; null past an end that does not wrap. */
  private frameAfter(from: number, step: number): number | null {
    const [first, last] = this.range();
    const span = last - first + 1;
    const target = from + step;
    if (target >= first && target <= last) return target;
    if (!this.inspection.loop()) return null;
    return first + ((((target - first) % span) + span) % span);
  }

  /** Move one frame by hand, which stops playback. */
  step(delta: number): void {
    this.pause();
    const target = this.frameAfter(this.frame(), delta);
    if (target !== null) this.frame.set(target);
  }

  /** Jump to a frame (timeline drag). Playback, if running, goes on from it. */
  seek(index: number): void {
    const [first, last] = this.range();
    this.frame.set(Math.max(first, Math.min(index, last)));
  }

  // ── Frame range ──────────────────────────────────────────────────────────

  /** The range's ends as shown: frames are numbered from 1 on screen. */
  readonly rangeStartShown = computed(() => {
    const start = this.inspection.rangeStart();
    return start === null ? null : start + 1;
  });
  readonly rangeEndShown = computed(() => {
    const end = this.inspection.rangeEnd();
    return end === null ? null : end + 1;
  });

  setRangeStart(shown: unknown): void {
    this.inspection.rangeStart.set(this.parseFrameNumber(shown));
  }

  setRangeEnd(shown: unknown): void {
    this.inspection.rangeEnd.set(this.parseFrameNumber(shown));
  }

  clearRange(): void {
    this.inspection.rangeStart.set(null);
    this.inspection.rangeEnd.set(null);
  }

  /** A frame number typed by the user (from 1) as an index; null when empty. */
  private parseFrameNumber(shown: unknown): number | null {
    if (shown === null || shown === undefined || shown === '') return null;
    const value = Number(shown);
    return Number.isFinite(value) ? Math.max(0, Math.round(value) - 1) : null;
  }

  // ── Sequences ────────────────────────────────────────────────────────────

  /** Whether the focused pane has a sequence to move to in that direction. */
  canStepSequence(delta: number): boolean {
    return this.sequenceAfterFocused(delta) !== null;
  }

  /** Swap the focused pane's sequence for the previous / next one. */
  stepSequence(delta: number): void {
    const target = this.sequenceAfterFocused(delta);
    if (target !== null) this.showInFocused(target);
  }

  /**
   * Show a sequence picked in the list: in the focused pane — or, when another
   * pane already shows it, by focusing that one.
   */
  selectSequence(id: number): void {
    const at = this.sequenceIds().indexOf(id);
    if (at >= 0) this.focusPane(at);
    else this.showInFocused(id);
  }

  /** Swap the focused pane's sequence for `target`. */
  private showInFocused(target: number): void {
    const focused = this.inspection.focused();
    this.sequenceIds.update((ids) =>
      ids.map((id, i) => (i === focused ? target : id)),
    );
    // Alone, a new sequence is a new video: start it from the beginning. In a
    // comparison the other panes define the position, so keep it.
    if (!this.multiple()) this.frame.set(this.inspection.rangeStart() ?? 0);
    this.shareFocused();
  }

  /**
   * The sequence `delta` away from the focused pane's in project order,
   * skipping those other panes already show; null at either end.
   */
  private sequenceAfterFocused(delta: number): number | null {
    const all = this.sequences.sequences();
    const ids = this.sequenceIds();
    const from = all.findIndex((s) => s.id === ids[this.inspection.focused()]);
    if (from < 0) return null;
    for (let i = from + delta; i >= 0 && i < all.length; i += delta) {
      if (!ids.includes(all[i].id)) return all[i].id;
    }
    return null;
  }

  focusPane(index: number): void {
    if (index === this.inspection.focused()) return;
    this.inspection.focused.set(index);
    this.shareFocused();
  }

  closePane(index: number): void {
    if (!this.multiple()) return;
    const focused = this.inspection.focused();
    this.sequenceIds.update((ids) => ids.filter((_, i) => i !== index));
    this.inspection.focused.set(
      Math.min(
        index < focused ? focused - 1 : focused,
        this.sequenceIds().length - 1,
      ),
    );
    this.shareFocused();
  }

  addPane(sequenceId: number | null): void {
    // Clear the picker whatever happens: it is a menu, not a value.
    this.sequenceToAdd.set(sequenceId);
    queueMicrotask(() => this.sequenceToAdd.set(null));
    if (sequenceId === null || !this.canAddPane()) return;
    if (this.sequenceIds().includes(sequenceId)) return;
    this.sequenceIds.update((ids) => [...ids, sequenceId]);
  }

  /** Leave for the editor on the frame pane `index` is showing. */
  async openInEditor(index: number, frameIndex: number): Promise<void> {
    this.pause();
    const id = this.sequenceIds()[index];
    if (id === undefined) return;
    if (await this.inspection.shareSequence(id, frameIndex)) {
      await this.uiState.navigateToEditor();
    }
  }

  /** Make the focused pane's sequence the one the rest of the app is on. */
  private shareFocused(): void {
    const id = this.sequenceIds()[this.inspection.focused()];
    if (id !== undefined) void this.inspection.shareSequence(id);
  }

  // ── View ─────────────────────────────────────────────────────────────────

  onViewChanged(source: number, view: RelativeView): void {
    if (!this.inspection.syncViews()) return;
    this.panes().forEach((pane, i) => {
      if (i !== source) pane.applyRelativeView(view);
    });
  }

  fitAll(): void {
    for (const pane of this.panes()) pane.fit();
  }

  isLabelHidden(id: number): boolean {
    return this.hiddenLabels().has(id);
  }

  toggleLabel(id: number): void {
    this.hiddenLabels.update((hidden) => {
      const next = new Set(hidden);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  // ── Keyboard ─────────────────────────────────────────────────────────────

  /**
   * Same layout as the editor: ↑/↓ move between frames, ←/→ between
   * sequences, Ctrl+E shows only the labels' edges. Space plays and pauses.
   */
  @HostListener('window:keydown', ['$event'])
  onKeydown(event: KeyboardEvent): void {
    if (!this.ready() || this.sequenceIds().length === 0) return;
    if (event.ctrlKey || event.metaKey || event.altKey) {
      const isEdgesShortcut =
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'e';
      if (isEdgesShortcut && this.legend().length > 0) {
        this.inspection.edgesOnly.update((on) => !on);
        event.preventDefault();
      }
      return;
    }
    // Leave a key to the focused control when that control uses it: typing
    // and pickers take everything, sliders the navigation keys, and Space on
    // a button presses it.
    const target = event.target instanceof Element ? event.target : null;
    const isSpace = event.key === ' ';
    if (
      target?.closest(
        'input, textarea, select, [contenteditable="true"], .p-select, .p-select-overlay',
      ) ||
      (isSpace && target?.closest('button')) ||
      (!isSpace && target?.closest('.p-slider'))
    ) {
      return;
    }

    switch (event.key) {
      case ' ':
        this.togglePlay();
        break;
      case 'ArrowUp':
        this.step(1);
        break;
      case 'ArrowDown':
        this.step(-1);
        break;
      case 'ArrowRight':
        this.stepSequence(1);
        break;
      case 'ArrowLeft':
        this.stepSequence(-1);
        break;
      case 'Home':
        this.pause();
        this.seek(0);
        break;
      case 'End':
        this.pause();
        this.seek(this.length() - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }
}
