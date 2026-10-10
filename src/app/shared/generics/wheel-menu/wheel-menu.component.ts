import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';

export enum SegmentType {
  toggle = 'toggle',
  button = 'button',
}

export interface MenuItem {
  label: string;
  /** PrimeIcons class. */
  icon: string;
  /** Material Symbols ligature, preferred over `icon`. */
  materialIcon?: string;
  /** Options of this entry, drawn as an outer ring while it is aimed at. */
  children?: MenuItem[];
  command?: () => void;
  /** State of a `toggle` child. */
  checked?: () => boolean;
  /** This is the entry in effect (the active tool). */
  active?: () => boolean;
  type?: SegmentType;
  disabled?: boolean;
}

interface Segment {
  path: string;
  cx: number;
  cy: number;
  startAngle: number;
  endAngle: number;
  children: Segment[];
  /** Where this entry's options ring starts, and the width of each option. It
   *  may fan out past the entry's own wedge. */
  childStart: number;
  childStep: number;
}

const DEG = Math.PI / 180;

/**
 * A pie (radial) menu.
 *
 * An entry is aimed at from the pointer's angle and distance, however far out
 * the pointer goes; the middle is a dead zone. Whatever is aimed at when the
 * menu closes is applied, not each entry the pointer passes over: a tool
 * change has side effects. Children are options of the aimed entry and take
 * a click.
 */
@Component({
  selector: 'app-wheel-menu',
  imports: [CommonModule],
  templateUrl: './wheel-menu.component.html',
  styleUrl: './wheel-menu.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WheelMenuComponent {
  private readonly host = inject(ElementRef<HTMLElement>);

  readonly items = input<MenuItem[]>([]);
  /** Outer edge of the ring of entries, in px. */
  readonly radius = input(150);
  readonly active = input(false);

  readonly closeMenu = output<void>();

  readonly svg = viewChild<ElementRef<SVGSVGElement>>('wheel');

  readonly segmentType = SegmentType;

  /** Dead zone, and the disc the aimed entry's name is printed on. */
  readonly hubRadius = 52;
  /** Where the ring of entries starts. */
  readonly ringInner = 62;
  /** How far past `radius` the children ring extends. */
  readonly childBand = 54;

  private readonly _aimed = signal<number | null>(null);
  private readonly _aimedChild = signal<number | null>(null);
  readonly aimed = this._aimed.asReadonly();
  readonly aimedChild = this._aimedChild.asReadonly();

  readonly outerRadius = computed(() => this.radius() + this.childBand);

  readonly viewBox = computed(() => {
    const dim = this.outerRadius() * 2;
    return `${-dim / 2} ${-dim / 2} ${dim} ${dim}`;
  });

  readonly boxSize = computed(() => this.outerRadius() * 2);

  readonly aimedItem = computed(() => {
    const i = this._aimed();
    return i === null ? null : (this.items()[i] ?? null);
  });

  readonly segments = computed<Segment[]>(() => {
    const items = this.items();
    const n = items.length;
    if (n === 0) return [];

    const step = 360 / n;
    // A little angular padding separates the wedges.
    const pad = Math.min(1.5, step * 0.04);
    const inner = this.ringInner;
    const outer = this.radius();

    return items.map((item, i) => {
      // Entry 0 is at the top; they run clockwise.
      const start = -90 - step / 2 + i * step;
      const end = start + step;

      const kids = item.children ?? [];
      // Enough arc per option to fit its label.
      const span =
        kids.length > 0
          ? Math.max(step, Math.min(170, kids.length * 46))
          : step;
      const childStep = kids.length > 0 ? span / kids.length : step;
      const childStart = (start + end) / 2 - span / 2;

      const seg: Segment = {
        path: this.ringPath(inner, outer, start + pad, end - pad),
        ...this.midpoint(inner, outer, start, end),
        startAngle: start,
        endAngle: end,
        children: [],
        childStart,
        childStep,
      };

      if (kids.length > 0) {
        const kPad = Math.min(1, childStep * 0.06);
        const r0 = outer + 6;
        const r1 = this.outerRadius();
        seg.children = kids.map((_, j) => {
          const kStart = childStart + j * childStep;
          const kEnd = kStart + childStep;
          return {
            path: this.ringPath(r0, r1, kStart + kPad, kEnd - kPad),
            ...this.midpoint(r0, r1, kStart, kEnd),
            startAngle: kStart,
            endAngle: kEnd,
            children: [],
            childStart: kStart,
            childStep,
          };
        });
      }
      return seg;
    });
  });

  constructor() {
    effect((onCleanup) => {
      if (!this.active()) {
        this._aimed.set(null);
        this._aimedChild.set(null);
        return;
      }
      // One resolution per frame.
      let pending: { x: number; y: number } | null = null;
      let frame = 0;
      const move = (ev: PointerEvent) => {
        pending = { x: ev.clientX, y: ev.clientY };
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (pending) this.aimAt(pending.x, pending.y);
        });
      };
      // On the window: aiming works past the wheel's own bounds.
      window.addEventListener('pointermove', move, { passive: true });
      onCleanup(() => {
        window.removeEventListener('pointermove', move);
        if (frame) cancelAnimationFrame(frame);
      });
    });
  }

  private aimAt(clientX: number, clientY: number): void {
    const el = this.svg()?.nativeElement ?? this.host.nativeElement;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;

    const dx = clientX - (rect.left + rect.width / 2);
    const dy = clientY - (rect.top + rect.height / 2);
    const dist = Math.hypot(dx, dy);

    const items = this.items();
    const n = items.length;
    if (n === 0) return;

    if (dist < this.hubRadius) {
      this.setAimed(null);
      this._aimedChild.set(null);
      return;
    }

    // Screen y grows downwards, as the clockwise sweep of the paths does.
    const deg = Math.atan2(dy, dx) / DEG;

    // Inside the options band the entry stays locked: its ring fans wider than
    // its own wedge.
    const current = this._aimed();
    const currentKids =
      current === null ? [] : (items[current].children ?? []);
    const inBand = dist > this.radius() && dist <= this.outerRadius();
    if (inBand && currentKids.length > 0) {
      const seg = this.segments()[current!];
      const rel = (((deg - seg.childStart) % 360) + 360) % 360;
      const j = Math.floor(rel / seg.childStep);
      this._aimedChild.set(j >= 0 && j < currentKids.length ? j : null);
      return;
    }

    const step = 360 / n;
    const first = -90 - step / 2;
    const rel = (((deg - first) % 360) + 360) % 360;
    this.setAimed(Math.min(n - 1, Math.floor(rel / step)));
    this._aimedChild.set(null);
  }

  private setAimed(index: number | null): void {
    this._aimed.set(index);
  }

  /** Run the entry aimed at. False when there is none. */
  commitAimed(): boolean {
    const index = this._aimed();
    if (index === null) return false;
    const item = this.items()[index];
    if (!item || item.disabled) return false;
    item.command?.();
    return true;
  }

  /** Toggle the aimed option if there is one, otherwise commit and close. */
  onClick(): void {
    const parent = this._aimed();
    const child = this._aimedChild();
    if (parent !== null && child !== null) {
      const item = this.items()[parent]?.children?.[child];
      if (item && !item.disabled) item.command?.();
      return; // options stay open so several can be set in one visit
    }
    this.closeMenu.emit();
  }

  isChecked(item: MenuItem): boolean {
    return item.checked?.() ?? false;
  }

  isActive(item: MenuItem): boolean {
    return item.active?.() ?? false;
  }

  private ringPath(r0: number, r1: number, a0: number, a1: number): string {
    const p = (r: number, a: number) =>
      `${(r * Math.cos(a * DEG)).toFixed(2)} ${(r * Math.sin(a * DEG)).toFixed(2)}`;
    const large = a1 - a0 > 180 ? 1 : 0;
    return [
      `M ${p(r0, a0)}`,
      `A ${r0} ${r0} 0 ${large} 1 ${p(r0, a1)}`,
      `L ${p(r1, a1)}`,
      `A ${r1} ${r1} 0 ${large} 0 ${p(r1, a0)}`,
      'Z',
    ].join(' ');
  }

  private midpoint(r0: number, r1: number, a0: number, a1: number) {
    const a = ((a0 + a1) / 2) * DEG;
    const r = (r0 + r1) / 2;
    return { cx: r * Math.cos(a), cy: r * Math.sin(a) };
  }
}
