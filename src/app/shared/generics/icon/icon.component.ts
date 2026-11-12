import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Line icons from the "Stage directions" redesign: 24×24, stroked with the
 * current text colour, sized by the font size (1em).
 */
export const ICON_PATHS = {
  pan: 'M12 2v20M2 12h20M9 5l3-3 3 3M9 19l3 3 3-3M5 9l-3 3 3 3M19 9l3 3-3 3',
  line: 'M5 19L19 5M3 21l2-2M19 5l2-2',
  eraser:
    'M7 21h13M5.5 15.5l9-9a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L11 20H7.5l-2-2a1.8 1.8 0 0 1 0-2.5zM10 11l5 5',
  lasso:
    'M7 22a5 5 0 0 1-2-4M3.3 14A7 7 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8-4.5 8-10 8a12 12 0 0 1-5-1M7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  lassox:
    'M7 22a5 5 0 0 1-2-4M3.3 14A7 7 0 0 1 2 10c0-4.4 4.5-8 10-8s10 3.6 10 8M7 18a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM15 15l6 6M21 15l-6 6',
  select: 'M5 3l6 17 2.5-7.5L21 10z',
  shape:
    'M12 19l7-7 3 3-7 7zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18zM2 2l7.6 7.6M11 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  box: 'M4 5h16v14H4z',
  ellipse: 'M12 19c5 0 9-3.1 9-7s-4-7-9-7-9 3.1-9 7 4 7 9 7z',
  nodes: 'M6 18L12 6l6 12M4 16h4v4H4zM10 3h4v4h-4zM16 16h4v4h-4z',
  trace: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  center: 'M3 20c5-1 4-8 9-8s4-7 9-8M3 20h.01M12 12h.01M21 4h.01',
  raster: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  spark:
    'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z',
  hint: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2z',
  layers: 'M12 2l10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5',
} as const;

export type IconName = keyof typeof ICON_PATHS;

@Component({
  selector: 'app-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      [attr.stroke-width]="weight()"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path [attr.d]="path()" />
    </svg>
  `,
  styles: `
    :host {
      display: inline-flex;
      width: 1em;
      height: 1em;
      flex: none;
      line-height: 1;
    }
    svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
  readonly weight = input(1.6);
  protected readonly path = computed(() => ICON_PATHS[this.name()]);
}
