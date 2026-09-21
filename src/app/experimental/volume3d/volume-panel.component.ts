import {
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { MaskVolumeService } from '../../services/mask-volume.service';
import { ProjectionViewComponent } from './projection/projection-view.component';
import { Volume3dViewComponent } from './volume3d-view.component';
import { Volume3dSettingsService } from './volume3d-settings.service';

const WIDTH_KEY = 'didascalie.volume3d.paneWidth';
const MIN_WIDTH = 240;

/**
 * The column beside the editor canvas while 3D mode is on: the 3D view above
 * the projection view. The left edge resizes the column, the bar between the
 * views moves the split, and either view can collapse to its header.
 */
@Component({
  selector: 'app-volume-panel',
  standalone: true,
  imports: [Volume3dViewComponent, ProjectionViewComponent],
  // The views (two WebGL contexts and a mesher worker) exist only while 3D
  // mode is on.
  template: `
    @if (volume.enabled()) {
      <div
        class="cursor-col-resize hover:bg-primary/40 shrink-0 w-1.5"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the 3D panel"
        (pointerdown)="startResize($event)"
      ></div>
      <div #column class="flex flex-1 flex-col min-h-0 min-w-0">
        <app-volume3d-view [style.flex]="flex3d()" />
        @if (settings().show3d && settings().showProjection) {
          <div
            class="cursor-row-resize h-1.5 hover:bg-primary/40 shrink-0"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the 3D and projection views"
            (pointerdown)="startSplit($event)"
          ></div>
        }
        <app-projection-view [style.flex]="flexProjection()" />
      </div>
    }
  `,
  host: {
    class: 'flex min-h-0 relative shrink-0',
    '[class.hidden]': '!volume.enabled()',
    '[style.width.px]': 'width()',
  },
})
export class VolumePanelComponent {
  readonly volume = inject(MaskVolumeService);
  private readonly settingsService = inject(Volume3dSettingsService);
  readonly settings = this.settingsService.settings;

  private readonly column =
    viewChild.required<ElementRef<HTMLDivElement>>('column');
  readonly width = signal(readWidth());

  /** A collapsed view shrinks to its header; an expanded one shares the rest. */
  readonly flex3d = computed(() => {
    const { show3d, showProjection, split } = this.settings();
    if (!show3d) return '0 0 auto';
    return showProjection ? `${split} 1 0` : '1 1 0';
  });
  readonly flexProjection = computed(() => {
    const { show3d, showProjection, split } = this.settings();
    if (!showProjection) return '0 0 auto';
    return show3d ? `${1 - split} 1 0` : '1 1 0';
  });

  startResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.width();
    track(
      (e) => {
        const max = window.innerWidth * 0.7;
        this.width.set(
          Math.round(
            Math.min(max, Math.max(MIN_WIDTH, startWidth + startX - e.clientX)),
          ),
        );
      },
      () => writeWidth(this.width()),
    );
  }

  startSplit(event: PointerEvent): void {
    event.preventDefault();
    const rect = this.column().nativeElement.getBoundingClientRect();
    track((e) => {
      const split = (e.clientY - rect.top) / rect.height;
      this.settingsService.update({
        split: Math.min(0.85, Math.max(0.15, split)),
      });
    });
  }
}

/** Follow the pointer until it is released. */
function track(move: (e: PointerEvent) => void, done?: () => void): void {
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    done?.();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function readWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (stored >= MIN_WIDTH) return stored;
  } catch {
    // Storage unavailable: default width.
  }
  return Math.round(Math.min(560, window.innerWidth * 0.35));
}

function writeWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Not persisted; harmless.
  }
}
