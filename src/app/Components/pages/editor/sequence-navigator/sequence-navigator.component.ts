import {
  Component,
  ElementRef,
  EventEmitter,
  OnInit,
  Output,
  effect,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PanelModule } from 'primeng/panel';

import { SequenceService } from '../../../../Services/sequence.service';
import { api } from '../../../../lib/api';
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
  imports: [CommonModule, PanelModule, GalleryElementComponent],
  templateUrl: './sequence-navigator.component.html',
  styleUrl: './sequence-navigator.component.scss',
})
export class SequenceNavigatorComponent implements OnInit {
  private readonly sequenceService = inject(SequenceService);
  private readonly host = inject(ElementRef<HTMLElement>);

  /** Emits the id of the sequence the user wants to jump to. */
  @Output() sequenceSelected = new EventEmitter<number>();

  sequences: NavSequence[] = [];

  constructor() {
    // Re-load statuses and re-scroll whenever the active sequence changes
    // (e.g. Next/Previous navigation or a save marking frames reviewed).
    effect(() => {
      this.sequenceService.currentSequence();
      void this.load();
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  get currentId(): number | null {
    return this.sequenceService.currentSequence()?.id ?? null;
  }

  async load(): Promise<void> {
    try {
      const [seqs, frameIdsBySequence] = await Promise.all([
        api.getGallerySequences(),
        api.getAllFrameIdsBySequence(),
      ]);

      this.sequences = seqs
        .filter((s) => s.frame_count > 0 && s.first_frame_id != null)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((s) => ({
          id: s.id,
          name: s.name,
          frameCount: s.frame_count,
          status: this.computeStatus(
            s.reviewed_count,
            s.annotated_count,
            s.frame_count,
          ),
          thumbnailFrameId: s.first_frame_id!,
          frameIds: frameIdsBySequence[s.id] ?? [],
        }));

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

  private scrollToCurrent(): void {
    setTimeout(() => {
      const el = this.host.nativeElement.querySelector('.is-current');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }
}
