import { Component, OnDestroy, OnInit, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { ColorPickerModule } from 'primeng/colorpicker';
import { FieldsetModule } from 'primeng/fieldset';
import { ProgressBarModule } from 'primeng/progressbar';
import { SelectButtonModule } from 'primeng/selectbutton';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ToggleSwitchModule } from 'primeng/toggleswitch';
import { TooltipModule } from 'primeng/tooltip';

import {
  AgreementReport,
  CaseScore,
  ComparisonStyle,
  FrameBasis,
  PairAgreement,
  api,
} from '../../lib/api';

/** How many of the worst and of the best cases are shown without asking. */
const SHOWN_EACH_END = 3;
/** Longest side, in pixels, of a case thumbnail and of the enlarged case. */
const THUMB_SIZE = 320;
const VIEW_SIZE = 1400;

/** Colours of a comparison: where both graders marked, only the first, only
 *  the second. */
interface ComparisonColors {
  both: string;
  a: string;
  b: string;
}

/** Agreement in white; disagreement in orange and sky blue, which stay apart
 *  under the common colour-vision deficiencies. */
const DEFAULT_COLORS: ComparisonColors = { both: '#ffffff', a: '#e69f00', b: '#56b4e9' };

/** A viewer preference, kept across projects and sessions. */
const STYLE_KEY = 'didascalie_agreement_style';

interface StoredStyle {
  colors: ComparisonColors;
  edgesOnly: boolean;
  edgeWidth: number;
}

function loadStyle(): StoredStyle {
  const fallback = { colors: DEFAULT_COLORS, edgesOnly: false, edgeWidth: 3 };
  try {
    const stored = JSON.parse(localStorage.getItem(STYLE_KEY) ?? 'null') as Partial<StoredStyle> | null;
    return {
      colors: { ...DEFAULT_COLORS, ...stored?.colors },
      edgesOnly: stored?.edgesOnly === true,
      edgeWidth: Number.isFinite(stored?.edgeWidth) ? Number(stored!.edgeWidth) : fallback.edgeWidth,
    };
  } catch {
    return fallback;
  }
}

/** A case as offered in the "any frame" list. */
interface CaseOption extends CaseScore {
  caption: string;
}

/**
 * Inter-grader agreement, pair by pair and overall. The statistics are
 * computed and documented in `src-tauri/src/commands/agreement.rs`.
 */
@Component({
  selector: 'app-agreement',
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    ColorPickerModule,
    FieldsetModule,
    ProgressBarModule,
    SelectButtonModule,
    SelectModule,
    SliderModule,
    ToggleSwitchModule,
    TooltipModule,
  ],
  templateUrl: './agreement.component.html',
  styleUrl: './agreement.component.scss',
})
export class AgreementComponent implements OnInit, OnDestroy {
  readonly report = signal<AgreementReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  basis: FrameBasis = 'reviewedByBoth';
  readonly basisOptions: { label: string; value: FrameBasis }[] = [
    { label: 'Reviewed by both', value: 'reviewedByBoth' },
    { label: 'Annotated by both', value: 'annotatedByBoth' },
  ];

  /** The pair shown in detail, as grader ids. */
  readonly selected = signal<[number, number] | null>(null);

  readonly graders = computed(() => this.report()?.graders ?? []);
  readonly hasLabels = computed(() => (this.report()?.labels.length ?? 0) > 0);
  readonly hasTasks = computed(() => (this.report()?.tasks.length ?? 0) > 0);

  readonly selectedPair = computed<PairAgreement | null>(() => {
    const ids = this.selected();
    return ids ? (this.pair(ids[0], ids[1]) ?? null) : null;
  });

  // ── Qualitative cases ─────────────────────────────────────────────────────
  // The frames behind the selected pair's score for one label, drawn with both
  // graders' regions.

  /** The label the cases are drawn for. */
  readonly caseLabel = signal<number | null>(null);
  /** Every compared frame for the pair and label, least agreement first. */
  readonly cases = signal<CaseOption[]>([]);
  readonly casesLoading = signal(false);
  /** The case shown enlarged. */
  readonly chosen = signal<number | null>(null);
  /** Off shows the bare image, to see what the graders were looking at. */
  readonly showMarks = signal(true);

  private readonly stored = loadStyle();
  readonly colors = signal<ComparisonColors>(this.stored.colors);
  /** Outline the regions instead of filling them. */
  readonly edgesOnly = signal(this.stored.edgesOnly);
  /** Outline thickness, in pixels of the enlarged case. */
  readonly edgeWidth = signal(this.stored.edgeWidth);
  readonly maxEdgeWidth = 12;
  readonly hasCustomColors = computed(() => {
    const c = this.colors();
    return (Object.keys(DEFAULT_COLORS) as (keyof ComparisonColors)[]).some(
      (k) => c[k].toLowerCase() !== DEFAULT_COLORS[k],
    );
  });
  /** A colour being dragged through the picker, applied when it closes. */
  private draftColors: Partial<ComparisonColors> = {};

  /** Object URLs of the thumbnails by frame id, and of the enlarged case. */
  readonly thumbs = signal<Record<number, string>>({});
  readonly view = signal<string | null>(null);

  readonly worst = computed(() => this.cases().slice(0, SHOWN_EACH_END));
  /** Best first, and never repeating a frame already shown among the worst. */
  readonly best = computed(() => {
    const all = this.cases();
    return all.slice(Math.max(SHOWN_EACH_END, all.length - SHOWN_EACH_END)).reverse();
  });
  readonly chosenCase = computed(
    () => this.cases().find((c) => c.frameId === this.chosen()) ?? null,
  );

  /** Bumped on every reload, so a late reply for another pair is dropped. */
  private casesToken = 0;
  private viewToken = 0;
  private thumbsToken = 0;

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  ngOnDestroy(): void {
    this.releaseImages();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const report = await api.intergraderReport(this.basis);
      this.report.set(report);

      // Keep the selected pair if it still exists, else the first with something
      // to compare.
      const current = this.selected();
      if (!current || !this.pair(current[0], current[1])) {
        const first = report.pairs.find((p) => p.frames > 0) ?? report.pairs[0];
        this.selected.set(first ? [first.a, first.b] : null);
      }
      if (this.caseLabel() === null || !report.labels.some((l) => l.id === this.caseLabel())) {
        this.caseLabel.set(report.labels[0]?.id ?? null);
      }
      void this.loadCases();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** The pair of two graders, whichever way round they are asked for. */
  pair(a: number, b: number): PairAgreement | undefined {
    return this.report()?.pairs.find(
      (p) => (p.a === a && p.b === b) || (p.a === b && p.b === a),
    );
  }

  isSelected(a: number, b: number): boolean {
    const ids = this.selected();
    return !!ids && ((ids[0] === a && ids[1] === b) || (ids[0] === b && ids[1] === a));
  }

  select(a: number, b: number): void {
    if (a === b) return;
    this.selected.set([a, b]);
    void this.loadCases();
  }

  // ── Qualitative cases ────────────────────────────────────────────────────

  setCaseLabel(labelId: number): void {
    this.caseLabel.set(labelId);
    void this.loadCases();
  }

  choose(frameId: number): void {
    this.chosen.set(frameId);
    void this.loadView();
  }

  setShowMarks(show: boolean): void {
    this.showMarks.set(show);
    void this.loadView();
  }

  // ── Drawing style ─────────────────────────────────────────────────────────

  colorOf(which: keyof ComparisonColors): string {
    return this.draftColors[which] ?? this.colors()[which];
  }

  draftColor(which: keyof ComparisonColors, color: string): void {
    this.draftColors[which] = color;
  }

  /** The picker closed: redraw once, rather than at every step of a drag. */
  commitColor(which: keyof ComparisonColors): void {
    const color = this.draftColors[which];
    delete this.draftColors[which];
    if (!color || color.toLowerCase() === this.colors()[which].toLowerCase()) return;
    this.colors.update((c) => ({ ...c, [which]: color }));
    this.restyle();
  }

  resetColors(): void {
    this.draftColors = {};
    this.colors.set(DEFAULT_COLORS);
    this.restyle();
  }

  setEdgesOnly(edges: boolean): void {
    this.edgesOnly.set(edges);
    this.restyle();
  }

  /** Called when the slider is released, with the value it was left on. */
  setEdgeWidth(width: number | undefined): void {
    if (width == null || width === this.edgeWidth()) return;
    this.edgeWidth.set(width);
    this.restyle();
  }

  /** Remember the style and redraw every picture with it. */
  private restyle(): void {
    const style: StoredStyle = {
      colors: this.colors(),
      edgesOnly: this.edgesOnly(),
      edgeWidth: this.edgeWidth(),
    };
    try {
      localStorage.setItem(STYLE_KEY, JSON.stringify(style));
    } catch {
    }
    void this.loadView();
    void this.loadThumbs();
  }

  /** The style as the backend takes it, for a picture `size` pixels wide. The
   *  outline width is that of the enlarged case, scaled down for a thumbnail. */
  private styleFor(size: number): ComparisonStyle {
    const c = this.colors();
    const width = Math.max(1, Math.round((this.edgeWidth() * size) / VIEW_SIZE));
    return {
      colorA: c.a,
      colorB: c.b,
      colorBoth: c.both,
      edgeWidth: this.edgesOnly() ? width : 0,
    };
  }

  /** Score the selected pair frame by frame, then show the worst case. */
  private async loadCases(): Promise<void> {
    const token = ++this.casesToken;
    this.releaseImages();
    this.cases.set([]);
    this.chosen.set(null);

    const pair = this.selectedPair();
    const label = this.caseLabel();
    if (!pair || label === null || pair.frames === 0) return;

    this.casesLoading.set(true);
    try {
      const cases = await api.intergraderCases(pair.a, pair.b, label, this.basis);
      if (token !== this.casesToken) return;
      this.cases.set(
        cases.map((c) => ({ ...c, caption: `${c.name} — Dice ${c.dice.toFixed(2)}` })),
      );
      if (cases.length > 0) this.choose(cases[0].frameId);
      await this.loadThumbs();
    } catch (error) {
      if (token === this.casesToken) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (token === this.casesToken) this.casesLoading.set(false);
    }
  }

  /** (Re)draw the worst and best cases' thumbnails in the current style. */
  private async loadThumbs(): Promise<void> {
    const token = ++this.thumbsToken;
    const pair = this.selectedPair();
    const label = this.caseLabel();
    if (!pair || label === null) return;
    const shown = new Set([...this.worst(), ...this.best()].map((c) => c.frameId));
    try {
      await Promise.all(
        [...shown].map(async (frameId) => {
          const url = await this.fetchImage(pair, label, frameId, THUMB_SIZE, true);
          if (token !== this.thumbsToken) {
            URL.revokeObjectURL(url);
            return;
          }
          const previous = this.thumbs()[frameId];
          this.thumbs.update((thumbs) => ({ ...thumbs, [frameId]: url }));
          if (previous) URL.revokeObjectURL(previous);
        }),
      );
    } catch (error) {
      if (token === this.thumbsToken) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async loadView(): Promise<void> {
    const token = ++this.viewToken;
    const pair = this.selectedPair();
    const label = this.caseLabel();
    const frameId = this.chosen();
    if (!pair || label === null || frameId === null) return;
    try {
      const url = await this.fetchImage(pair, label, frameId, VIEW_SIZE, this.showMarks());
      if (token !== this.viewToken) {
        URL.revokeObjectURL(url);
        return;
      }
      const previous = this.view();
      this.view.set(url);
      if (previous) URL.revokeObjectURL(previous);
    } catch (error) {
      if (token === this.viewToken) {
        this.error.set(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async fetchImage(
    pair: PairAgreement,
    label: number,
    frameId: number,
    size: number,
    marks: boolean,
  ): Promise<string> {
    const bytes = await api.intergraderCaseImage(
      frameId,
      pair.a,
      pair.b,
      label,
      size,
      marks,
      this.styleFor(size),
    );
    return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
  }

  /** Object URLs hold their image in memory until revoked. */
  private releaseImages(): void {
    this.viewToken++;
    this.thumbsToken++;
    for (const url of Object.values(this.thumbs())) URL.revokeObjectURL(url);
    this.thumbs.set({});
    const view = this.view();
    if (view) URL.revokeObjectURL(view);
    this.view.set(null);
  }

  name(id: number): string {
    return this.graders().find((g) => g.id === id)?.name ?? '?';
  }

  labelName(id: number): string {
    return this.report()?.labels.find((l) => l.id === id)?.name ?? '?';
  }

  labelColor(id: number): string {
    return this.report()?.labels.find((l) => l.id === id)?.color ?? 'transparent';
  }

  isMultilabel(task: string): boolean {
    return this.report()?.tasks.find((t) => t.name === task)?.multilabel ?? false;
  }

  /** Two decimals, or a dash for a statistic that is undefined. */
  num(value: number | null | undefined): string {
    return value == null ? '—' : value.toFixed(2);
  }

  percent(value: number | null | undefined): string {
    return value == null ? '—' : `${Math.round(value * 100)}%`;
  }
}
