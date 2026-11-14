import { Injectable, computed, signal } from '@angular/core';
import { ProjectScoped } from '../core/project-scoped';

/** A sequence on the list, with what it can be sorted by. */
export interface WorklistEntry {
  id: number;
  title: string;
  frameCount: number;
  /** Reviewed frames over all frames, 0..1. */
  progress: number;
  /** Classification task -> the classes at least one frame was given. */
  classes: Record<string, string[] | undefined>;
  /** Regression task -> the mean of the values its frames were given. */
  regressions: Record<string, number | undefined>;
}

/** Something the list can be sorted by. */
export interface SortField {
  /** `name`, `frames`, `progress`, or `class:<task>` / `value:<task>`. */
  id: string;
  label: string;
  /** What is compared; `undefined` (no answer) sorts last either way. */
  value: (entry: WorklistEntry) => string | number | undefined;
}

/** One level of the sort: a field and its direction. */
export interface SortKey {
  field: string;
  descending: boolean;
}

const BASE_FIELDS: readonly SortField[] = [
  { id: 'name', label: 'Name', value: (e) => e.title },
  { id: 'frames', label: 'Frames', value: (e) => e.frameCount },
  { id: 'progress', label: 'Progress', value: (e) => e.progress },
];

function compareValues(
  a: string | number | undefined,
  b: string | number | undefined,
  descending: boolean,
): number {
  if (a === undefined || b === undefined) {
    return a === b ? 0 : a === undefined ? 1 : -1;
  }
  const order =
    typeof a === 'string' || typeof b === 'string'
      ? String(a).localeCompare(String(b), undefined, { numeric: true })
      : a - b;
  return descending ? -order : order;
}

/**
 * The sequences the user is working through: the gallery's filters applied,
 * sorted by the sort keys. The editor's and the inspector's next/previous and
 * Sequences panels follow this list, so leaving the gallery on "Not started"
 * keeps both on not-started sequences.
 *
 * The entries are a snapshot taken when the gallery last applied its filters.
 * They do not change while annotating: a sequence that stops matching the
 * filter (marked reviewed, say) keeps its place until the gallery is shown
 * again. The sort is live, though: the gallery and the inspector both change
 * it, and the list reorders at once.
 */
@Injectable({ providedIn: 'root' })
export class WorklistService implements ProjectScoped {
  private readonly _entries = signal<readonly WorklistEntry[] | null>(null);
  private readonly _filters = signal('');
  private readonly _taskFields = signal<readonly SortField[]>([]);

  /** Levels of the sort, first one first. None: the project's order. */
  readonly sortKeys = signal<readonly SortKey[]>([]);

  /** The fields offered: the fixed ones, then the project's tasks. */
  readonly fields = computed(() => [...BASE_FIELDS, ...this._taskFields()]);

  /** The gallery has set a list. */
  readonly active = computed(() => this._entries() !== null);

  /** Ordered sequence ids; null when the gallery has not set one. */
  readonly ids = computed<readonly number[] | null>(() => {
    const entries = this._entries();
    if (!entries) return null;
    const fields = new Map(this.fields().map((f) => [f.id, f]));
    const keys = this.sortKeys().flatMap((key) => {
      const field = fields.get(key.field);
      return field ? [{ field, descending: key.descending }] : [];
    });
    if (keys.length === 0) return entries.map((e) => e.id);
    // Array.sort is stable: ties keep the project's order.
    return [...entries]
      .sort((a, b) => {
        for (const { field, descending } of keys) {
          const order = compareValues(field.value(a), field.value(b), descending);
          if (order !== 0) return order;
        }
        return 0;
      })
      .map((e) => e.id);
  });

  /** The sort in words ("Progress ↓ · Name ↑"); empty when unsorted. */
  readonly sortDescription = computed(() => {
    const labels = new Map(this.fields().map((f) => [f.id, f.label]));
    return this.sortKeys()
      .filter((key) => labels.has(key.field))
      .map((key) => `${labels.get(key.field)} ${key.descending ? '↓' : '↑'}`)
      .join(' · ');
  });

  /** The gallery filters behind the list, in words; empty when none. */
  readonly filterDescription = this._filters.asReadonly();

  /** The filters and sort behind the list, for display ("Not started ·
   *  Progress ↑"); empty when nothing narrows or reorders it. */
  readonly description = computed(() =>
    [this._filters(), this.sortDescription()].filter(Boolean).join(' · '),
  );
  readonly size = computed(() => this._entries()?.length ?? 0);

  /** The filtered sequences, in the project's order, and the filters in words. */
  set(entries: readonly WorklistEntry[], filterDescription: string): void {
    this._entries.set([...entries]);
    this._filters.set(filterDescription);
  }

  /** The project's task fields; levels on a task that is gone are dropped. */
  setTaskFields(fields: readonly SortField[]): void {
    this._taskFields.set([...fields]);
    const known = new Set(this.fields().map((f) => f.id));
    if (this.sortKeys().some((key) => !known.has(key.field))) {
      this.sortKeys.update((keys) => keys.filter((key) => known.has(key.field)));
    }
  }

  /** The level sorting by `field`, if there is one. */
  sortKeyOf(field: string): SortKey | undefined {
    return this.sortKeys().find((key) => key.field === field);
  }

  /**
   * Step `field` through its three states: not sorted by, ascending (added
   * after the levels already set), descending (in the same place), and back.
   */
  cycleSort(field: string): void {
    this.sortKeys.update((keys) => {
      const key = keys.find((k) => k.field === field);
      if (!key) return [...keys, { field, descending: false }];
      if (!key.descending) {
        return keys.map((k) => (k === key ? { ...k, descending: true } : k));
      }
      return keys.filter((k) => k !== key);
    });
  }

  clearSort(): void {
    this.sortKeys.set([]);
  }

  /** Position of a sequence in the list, -1 when absent. */
  indexOf(sequenceId: number | null | undefined): number {
    if (sequenceId == null) return -1;
    return this.ids()?.indexOf(sequenceId) ?? -1;
  }

  /**
   * The sequence `step` places after `sequenceId`; null at either end. Also
   * null when there is no list or the sequence is not on it, so the caller
   * falls back to the project's order.
   */
  neighbour(sequenceId: number | null | undefined, step: number): number | null {
    const ids = this.ids();
    const index = this.indexOf(sequenceId);
    if (!ids || index < 0) return null;
    return ids[index + step] ?? null;
  }

  /**
   * `items` as the list has them: only those on it, in its order. Unchanged
   * when the gallery has not set a list.
   */
  order<T>(items: readonly T[], idOf: (item: T) => number): T[];
  order<T extends { id: number }>(items: readonly T[]): T[];
  order<T>(items: readonly T[], idOf?: (item: T) => number): T[] {
    const ids = this.ids();
    if (!ids) return [...items];
    const key = idOf ?? ((item: T) => (item as { id: number }).id);
    const byId = new Map(items.map((item) => [key(item), item]));
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is T => item !== undefined);
  }

  /**
   * @see ProjectScoped
   *
   * The sort is a preference and is kept, except its levels on the old
   * project's tasks.
   */
  resetForProject(): void {
    this._entries.set(null);
    this._filters.set('');
    this._taskFields.set([]);
    const base = new Set(BASE_FIELDS.map((f) => f.id));
    this.sortKeys.update((keys) => keys.filter((key) => base.has(key.field)));
  }
}
