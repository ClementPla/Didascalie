import {
  Component,
  ElementRef,
  OnInit,
  effect,
  inject,
  output
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { PanelModule } from 'primeng/panel';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';

import { PropagationService } from '../../../services/labels/propagation.service';
import { SequenceService } from '../../../services/sequence.service';
import { api } from '../../../lib/api';
import { GalleryElementComponent } from '../../gallery/gallery-element/gallery-element.component';

type SequenceStatus = 'empty' | 'annotated' | 'reviewed';

interface NavSequence {
  id: number;
  name: string;
  frameCount: number;
  status: SequenceStatus;
  thumbnailFrameId: number;
  frameIds: number[];
}

@Component({
  selector: 'app-sequence-navigator',
  standalone: true,
  imports: [
    CommonModule,
    PanelModule,
    PaginatorModule,
    GalleryElementComponent,
  ],
  templateUrl: './sequence-navigator.component.html',
  styleUrl: './sequence-navigator.component.scss',
})
export class SequenceNavigatorComponent implements OnInit {
  private readonly sequenceService = inject(SequenceService);
  private readonly propagation = inject(PropagationService);
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly sequenceSelected = output<number>();

  sequences: NavSequence[] = [];

  /** Sequences rendered at once: a project can have thousands. */
  readonly pageSize = 60;
  first = 0;

  constructor() {
    effect(() => {
      this.sequenceService.currentSequence();
      void this.load();
    });

    // Propagation annotates frames that are not displayed.
    this.propagation.propagated$
      .pipe(takeUntilDestroyed())
      .subscribe(() => void this.load());
  }

  ngOnInit(): void {
    void this.load();
  }

  get currentId(): number | null {
    return this.sequenceService.currentSequence()?.id ?? null;
  }

  get pagedSequences(): NavSequence[] {
    return this.sequences.slice(this.first, this.first + this.pageSize);
  }

  onPage(event: PaginatorState): void {
    this.first = event.first ?? 0;
    this.scrollListTop();
  }

  async load(): Promise<void> {
    try {
      const [seqs, frameIdsBySequence] = await Promise.all([
        api.getGallerySequences(),
        api.getAllFrameIdsBySequence(),
      ]);

      this.sequences = seqs
        .filter((s) => s.frameCount > 0 && s.firstFrameId != null)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((s) => ({
          id: s.id,
          name: s.name,
          frameCount: s.frameCount,
          status: this.computeStatus(
            s.reviewedCount,
            s.annotatedCount,
            s.frameCount,
          ),
          thumbnailFrameId: s.firstFrameId!,
          frameIds: frameIdsBySequence[s.id] ?? [],
        }));

      this.focusCurrentPage();
      this.scrollToCurrent();
    } catch (error) {
      console.error('Failed to load sequence navigator:', error);
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

  select(seq: NavSequence): void {
    this.sequenceSelected.emit(seq.id);
  }

  private focusCurrentPage(): void {
    const id = this.currentId;
    if (id == null) return;
    const index = this.sequences.findIndex((s) => s.id === id);
    if (index >= 0) {
      this.first = Math.floor(index / this.pageSize) * this.pageSize;
    }
  }

  private scrollToCurrent(): void {
    setTimeout(() => {
      const el = this.host.nativeElement.querySelector('.is-current');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  private scrollListTop(): void {
    setTimeout(() => {
      const list = this.host.nativeElement.querySelector('.sequence-list');
      list?.scrollTo({ top: 0 });
    });
  }
}
