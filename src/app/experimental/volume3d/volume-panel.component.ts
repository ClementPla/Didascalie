import {
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';

import { MaskVolumeService } from '../../services/mask-volume.service';
import { NotificationService } from '../../services/notification.service';
import { DetachedWindow, detachElement } from '../../shared/detached-window/detached-window';
import { ProjectionViewComponent } from './projection/projection-view.component';
import { Volume3dViewComponent } from './volume3d-view.component';
import { Volume3dSettingsService } from './volume3d-settings.service';
import { VolumeLayoutService, VolumeViewId } from './volume-layout.service';

const WIDTH_KEY = 'didascalie.volume3d.paneWidth';
const MIN_WIDTH = 240;
const RAIL_WIDTH = 28;

const TITLES: Record<VolumeViewId, string> = {
  '3d': 'Didascalie · 3D view',
  projection: 'Didascalie · Projection',
};

/**
 * The column beside the editor canvas while 3D mode is on: the 3D view above
 * the projection view. The left edge resizes the column (its button folds it
 * to a rail), the bar between the views moves the split, and either view can
 * collapse to its header.
 *
 * Each view can also leave the column (see `VolumeLayoutService`): maximized
 * over the whole editor area, or detached into its own window. A detached
 * view's DOM is moved into the window (`detachElement`) and comes back when
 * the window closes; the component itself never leaves this template.
 */
@Component({
  selector: 'app-volume-panel',
  standalone: true,
  imports: [ButtonModule, TooltipModule, Volume3dViewComponent, ProjectionViewComponent],
  // The views (two WebGL contexts and a mesher worker) exist only while 3D
  // mode is on.
  template: `
    @if (volume.enabled()) {
      @if (layout.panelCollapsed()) {
        <div class="flex flex-col items-center pt-2 shrink-0 w-full">
          <p-button
            icon="pi pi-angle-double-left"
            size="small"
            [text]="true"
            severity="secondary"
            pTooltip="Show the 3D panel"
            tooltipPosition="left"
            ariaLabel="Show the 3D panel"
            (onClick)="layout.panelCollapsed.set(false)"
          />
          <span
            class="mt-2 opacity-60 text-xs"
            style="writing-mode: vertical-rl"
            >3D</span
          >
        </div>
      } @else if (dockedCount() > 0) {
        <div class="relative shrink-0 w-1.5">
          <div
            class="absolute cursor-col-resize hover:bg-primary/40 inset-0"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize the 3D panel"
            (pointerdown)="startResize($event)"
          ></div>
          <button
            type="button"
            class="absolute bg-surface-500/30 flex hover:bg-primary/60 items-center justify-center left-1/2 rounded-full text-xs top-2 z-10"
            style="width: 18px; height: 18px; transform: translateX(-50%)"
            title="Hide the 3D panel"
            aria-label="Hide the 3D panel"
            (click)="layout.panelCollapsed.set(true)"
          >
            <i class="pi pi-angle-double-right" style="font-size: 0.65rem"></i>
          </button>
        </div>
      }
      <div #column class="flex flex-1 flex-col min-h-0 min-w-0">
        <app-volume3d-view
          [style.flex]="flex3d()"
          [class.hidden]="hiddenInPanel('3d')"
          [class.volume-maximized]="layout.modes()['3d'] === 'maximized'"
        />
        @if (showSplitter()) {
          <div
            class="cursor-row-resize h-1.5 hover:bg-primary/40 shrink-0"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize the 3D and projection views"
            (pointerdown)="startSplit($event)"
          ></div>
        }
        <app-projection-view
          [style.flex]="flexProjection()"
          [class.hidden]="hiddenInPanel('projection')"
          [class.volume-maximized]="layout.modes().projection === 'maximized'"
        />
      </div>
    }
  `,
  styles: `
    /* Over the whole editor area: the canvas column is the nearest
       positioned ancestor while a view is maximized (see the host's
       'relative' binding). */
    .volume-maximized {
      position: absolute;
      inset: 0;
      z-index: 30;
      background: var(--p-content-background);
    }
  `,
  host: {
    class: 'flex min-h-0 shrink-0',
    '[class.relative]': '!layout.maximized()',
    '[class.hidden]': '!volume.enabled()',
    '[style.width.px]': 'hostWidth()',
  },
})
export class VolumePanelComponent implements OnDestroy {
  readonly volume = inject(MaskVolumeService);
  readonly layout = inject(VolumeLayoutService);
  private readonly settingsService = inject(Volume3dSettingsService);
  private readonly notifications = inject(NotificationService);
  readonly settings = this.settingsService.settings;

  private readonly column = viewChild<ElementRef<HTMLDivElement>>('column');
  private readonly view3d = viewChild(Volume3dViewComponent);
  private readonly view3dHost = viewChild(Volume3dViewComponent, { read: ElementRef });
  private readonly projectionView = viewChild(ProjectionViewComponent);
  private readonly projectionHost = viewChild(ProjectionViewComponent, { read: ElementRef });

  readonly width = signal(readWidth());
  private readonly windows = new Map<VolumeViewId, DetachedWindow>();

  /** Views shown in the column itself. */
  private readonly docked = computed(() => {
    const modes = this.layout.modes();
    return {
      '3d': modes['3d'] === 'docked',
      projection: modes.projection === 'docked',
    };
  });
  readonly dockedCount = computed(() => Object.values(this.docked()).filter(Boolean).length);

  readonly hostWidth = computed(() => {
    if (this.layout.panelCollapsed()) return RAIL_WIDTH;
    return this.dockedCount() > 0 ? this.width() : 0;
  });

  readonly showSplitter = computed(() => {
    const { show3d, showProjection } = this.settings();
    const docked = this.docked();
    return !this.layout.panelCollapsed() && docked['3d'] && docked.projection && show3d && showProjection;
  });

  /** A collapsed view shrinks to its header; an expanded one shares the rest. */
  readonly flex3d = computed(() => this.flexOf('3d'));
  readonly flexProjection = computed(() => this.flexOf('projection'));

  constructor() {
    // Detach / re-dock views as their mode changes.
    effect(() => {
      const modes = this.layout.modes();
      // The views exist only once 3D mode is on.
      const ready = !!this.view3dHost() && !!this.projectionHost();
      untracked(() => {
        if (ready) {
          this.applyDetached('3d', modes['3d'] === 'detached');
          this.applyDetached('projection', modes.projection === 'detached');
        }
      });
    });

    // Leaving 3D mode closes the windows and forgets the layout.
    effect(() => {
      if (!this.volume.enabled()) {
        untracked(() => {
          this.closeWindows();
          this.layout.reset();
        });
      }
    });
  }

  ngOnDestroy(): void {
    this.closeWindows();
  }

  /** Escape restores a maximized view. */
  @HostListener('window:keydown.escape')
  onEscape(): void {
    const id = this.layout.maximized();
    if (id) this.layout.set(id, 'docked');
  }

  hiddenInPanel(id: VolumeViewId): boolean {
    return this.layout.panelCollapsed() && this.layout.modes()[id] === 'docked';
  }

  private flexOf(id: VolumeViewId): string {
    const mode = this.layout.modes()[id];
    if (mode !== 'docked') return '1 1 0';
    const { show3d, showProjection, split } = this.settings();
    const expanded = id === '3d' ? show3d : showProjection;
    if (!expanded) return '0 0 auto';
    const other: VolumeViewId = id === '3d' ? 'projection' : '3d';
    const otherShares = this.docked()[other] && (other === '3d' ? show3d : showProjection);
    if (!otherShares) return '1 1 0';
    return `${id === '3d' ? split : 1 - split} 1 0`;
  }

  private applyDetached(id: VolumeViewId, detached: boolean): void {
    const open = this.windows.get(id);
    if (!detached) {
      open?.close(); // onReturn re-docks the view
      return;
    }
    if (open) return;

    const host = (id === '3d' ? this.view3dHost() : this.projectionHost())?.nativeElement as HTMLElement | undefined;
    const view = id === '3d' ? this.view3d() : this.projectionView();
    if (!host || !view) return;
    const handle = detachElement(host, {
      title: TITLES[id],
      width: Math.max(640, Math.round(host.clientWidth)),
      height: Math.max(480, Math.round(host.clientHeight)),
      onReturn: () => {
        this.windows.delete(id);
        view.relocated(false);
        if (this.layout.mode(id) === 'detached') this.layout.set(id, 'docked');
      },
    });
    if (!handle) {
      this.layout.set(id, 'docked');
      this.notifications.error('Could not open a window', 'The view stays in the panel.');
      return;
    }
    this.windows.set(id, handle);
    view.relocated(true);
  }

  private closeWindows(): void {
    for (const handle of [...this.windows.values()]) handle.close();
    this.windows.clear();
  }

  startResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this.width();
    track(
      (e) => {
        const max = window.innerWidth * 0.7;
        this.width.set(Math.round(Math.min(max, Math.max(MIN_WIDTH, startWidth + startX - e.clientX))));
      },
      () => writeWidth(this.width()),
    );
  }

  startSplit(event: PointerEvent): void {
    event.preventDefault();
    const column = this.column();
    if (!column) return;
    const rect = column.nativeElement.getBoundingClientRect();
    track((e) => {
      const split = (e.clientY - rect.top) / rect.height;
      this.settingsService.update({ split: Math.min(0.85, Math.max(0.15, split)) });
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
