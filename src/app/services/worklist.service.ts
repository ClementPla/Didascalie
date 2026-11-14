import { Injectable, computed, signal } from '@angular/core';
import { ProjectScoped } from '../core/project-scoped';

/**
 * The sequences the user is working through, in the order the gallery shows
 * them: its filters and sort applied. The editor's and the inspector's
 * next/previous and Sequences panels follow this list, so leaving the gallery
 * on "Not started" keeps both on not-started sequences.
 *
 * The list is a snapshot taken when the gallery last applied its filters. It
 * does not change while annotating: a sequence that stops matching the filter
 * (marked reviewed, say) keeps its place until the gallery is shown again.
 */
@Injectable({ providedIn: 'root' })
export class WorklistService implements ProjectScoped {
  private readonly _ids = signal<readonly number[] | null>(null);
  private readonly _description = signal('');

  /** Ordered sequence ids; null when the gallery has not set one. */
  readonly ids = this._ids.asReadonly();
  /** The filters and sort behind the list, for display ("Not started ·
   *  Least progress"); empty when nothing narrows or reorders it. */
  readonly description = this._description.asReadonly();
  readonly size = computed(() => this._ids()?.length ?? 0);

  set(ids: readonly number[], description: string): void {
    this._ids.set([...ids]);
    this._description.set(description);
  }

  /** Position of a sequence in the list, -1 when absent. */
  indexOf(sequenceId: number | null | undefined): number {
    if (sequenceId == null) return -1;
    return this._ids()?.indexOf(sequenceId) ?? -1;
  }

  /**
   * The sequence `step` places after `sequenceId`; null at either end. Also
   * null when there is no list or the sequence is not on it, so the caller
   * falls back to the project's order.
   */
  neighbour(sequenceId: number | null | undefined, step: number): number | null {
    const ids = this._ids();
    const index = this.indexOf(sequenceId);
    if (!ids || index < 0) return null;
    return ids[index + step] ?? null;
  }

  /**
   * `items` as the list has them: only those on it, in its order. Unchanged
   * when the gallery has not set a list.
   */
  order<T extends { id: number }>(items: readonly T[]): T[] {
    const ids = this._ids();
    if (!ids) return [...items];
    const byId = new Map(items.map((item) => [item.id, item]));
    return ids
      .map((id) => byId.get(id))
      .filter((item): item is T => item !== undefined);
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this._ids.set(null);
    this._description.set('');
  }
}
