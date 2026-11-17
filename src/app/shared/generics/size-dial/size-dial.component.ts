import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  model,
  signal,
  viewChild,
} from '@angular/core';

/**
 * How the value reads on the circle:
 * - `radius`: the circle's radius is the value;
 * - `diameter`: its width is the value (a gap, a stroke);
 * - `area`: its area is the value, so the radius grows as its square root.
 */
export type SizeDialMode = 'radius' | 'diameter' | 'area';

/** Drawing units: the SVG is VIEW × VIEW, centred. */
const VIEW = 120;
const CENTER = VIEW / 2;
/** Radius drawn for the largest value, and for the smallest. */
const R_MAX = 52;
const R_MIN = 3;
/** Guide rings: no closer to each other (or the ends) than this fraction. */
const GUIDE_GAP = 0.16;
/** Shift-drag moves the value this much slower. */
const FINE = 0.2;
/** A touch must move this far (CSS px) before it drags, so a tap or the
 *  start of a scroll does not change the value. */
const TOUCH_SLOP = 6;

/**
 * A size picked by pulling a circle: press anywhere on the dial and drag
 * away from the centre to grow it, toward it to shrink it; hold Shift for
 * finer control. The − and + buttons, the wheel and the arrow keys step the
 * value; Page Up/Down take bigger steps, Home/End go to the ends.
 *
 * On a touch screen a drag starts once the finger has moved a little, and
 * the value shows above the dial while the finger covers it.
 *
 * With a `knee`, the scale is logarithmic above it: small values get as much
 * travel as large ones, so 1, 2 and 3 px are easy to tell apart and to pick.
 * Labelled guide rings keep the scale readable.
 */
@Component({
  selector: 'app-size-dial',
  templateUrl: './size-dial.component.html',
  styleUrl: './size-dial.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SizeDialComponent {
  readonly value = model.required<number>();
  readonly min = input(0);
  readonly max = input(100);
  readonly step = input(1);
  readonly mode = input<SizeDialMode>('radius');
  /** Shown after the value. */
  readonly unit = input('px');
  /** Shown instead of the value when it is 0 (e.g. "any"). */
  readonly zeroLabel = input<string | null>(null);
  /** The circle's colour; the primary colour when not given. */
  readonly color = input<string | null>(null);
  readonly ariaLabel = input('Size');
  /** Below this distance from `min` the scale is near linear, above it
   *  logarithmic; null for a linear scale (a linear area scale for `area`). */
  readonly knee = input<number | null>(null);

  readonly view = VIEW;
  readonly center = CENTER;
  readonly rMax = R_MAX;

  private readonly svg = viewChild.required<ElementRef<SVGSVGElement>>('svg');
  /** The pointer dragging the circle, if any. */
  private dragPointer: number | null = null;
  readonly dragging = signal(false);
  /** The drag is a finger's: the value shows above the dial. */
  readonly touchDrag = signal(false);
  /** A touch not yet moved past the slop: where it started. */
  private pending: { x: number; y: number } | null = null;
  /** Where the knob sits on the circle, in radians: it follows the drag. */
  readonly angle = signal(-Math.PI / 4);
  /** During a Shift-drag: the pointer's last distance from the centre, and
   *  the fraction reached so far, unsnapped so slow moves still add up. */
  private fine: { distance: number; fraction: number } | null = null;

  /** Where the value sits in the range, from 0 to 1, as the circle shows it. */
  private readonly fraction = computed(() => this.toFraction(this.value()));

  readonly radius = computed(() => R_MIN + this.fraction() * (R_MAX - R_MIN));
  /** The value is beyond what the dial shows. */
  readonly overflow = computed(() => this.value() > this.max());

  readonly knob = computed(() => ({
    x: CENTER + this.radius() * Math.cos(this.angle()),
    y: CENTER + this.radius() * Math.sin(this.angle()),
  }));

  /** The guide rings: round values (1, 2, 5, 10, 20, 50…) spread over the
   *  dial, each with its value. */
  readonly guides = computed(() => {
    const min = this.min();
    const max = this.max();
    const rings: { r: number; value: number; label: string }[] = [];
    let last = 0;
    for (const v of niceValues(min, max)) {
      const f = this.toFraction(v);
      if (f - last < GUIDE_GAP || 1 - f < GUIDE_GAP) continue;
      rings.push({ r: R_MIN + f * (R_MAX - R_MIN), value: v, label: this.format(v) });
      last = f;
    }
    return rings;
  });

  readonly display = computed(() => {
    const v = this.value();
    const zero = this.zeroLabel();
    if (v === 0 && zero) return zero;
    return `${this.format(v)}${this.overflow() ? '+' : ''}`;
  });

  readonly maxLabel = computed(() => `${this.format(this.max())} ${this.unit()}`);

  /** A diameter is drawn as a line across the circle, a radius from the centre. */
  readonly measure = computed(() => {
    const r = this.radius();
    const a = this.angle();
    const dx = r * Math.cos(a);
    const dy = r * Math.sin(a);
    return this.mode() === 'diameter'
      ? { x1: CENTER - dx, y1: CENTER - dy, x2: CENTER + dx, y2: CENTER + dy }
      : { x1: CENTER, y1: CENTER, x2: CENTER + dx, y2: CENTER + dy };
  });

  onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    (event.currentTarget as SVGElement).focus();
    this.dragPointer = event.pointerId;
    this.dragging.set(true);
    this.fine = null;
    if (event.pointerType === 'touch') {
      this.touchDrag.set(true);
      this.pending = { x: event.clientX, y: event.clientY };
    } else {
      this.follow(event);
    }
  }

  onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== this.dragPointer) return;
    if (this.pending) {
      const moved = Math.hypot(event.clientX - this.pending.x, event.clientY - this.pending.y);
      if (moved < TOUCH_SLOP) return;
      this.pending = null;
    }
    this.follow(event);
  }

  onPointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.dragPointer) return;
    this.dragPointer = null;
    this.dragging.set(false);
    this.touchDrag.set(false);
    this.pending = null;
    this.fine = null;
  }

  /** The − and + buttons. */
  stepBy(direction: 1 | -1): void {
    this.nudge(direction);
  }

  onWheel(event: WheelEvent): void {
    event.preventDefault();
    this.nudge(event.deltaY < 0 ? 1 : -1);
  }

  onKeyDown(event: KeyboardEvent): void {
    const big = Math.max(1, Math.round((this.max() - this.min()) / this.step() / 10));
    switch (event.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        this.nudge(1);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        this.nudge(-1);
        break;
      case 'PageUp':
        this.nudge(big);
        break;
      case 'PageDown':
        this.nudge(-big);
        break;
      case 'Home':
        this.value.set(this.min());
        break;
      case 'End':
        this.value.set(this.max());
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  /** Set the value from the pointer: its distance to the centre, or with
   *  Shift, how far it moved since, at a fraction of the speed. */
  private follow(event: PointerEvent): void {
    const box = this.svg().nativeElement.getBoundingClientRect();
    if (box.width === 0) return;
    const unit = VIEW / box.width;
    const dx = (event.clientX - box.left) * unit - CENTER;
    const dy = (event.clientY - box.top) * unit - CENTER;
    const distance = Math.hypot(dx, dy);
    if (distance > 1) this.angle.set(Math.atan2(dy, dx));

    let f: number;
    if (event.shiftKey) {
      const from = this.fine ?? { distance, fraction: this.fraction() };
      f = from.fraction + ((distance - from.distance) / (R_MAX - R_MIN)) * FINE;
      f = Math.max(0, Math.min(1, f));
      this.fine = { distance, fraction: f };
    } else {
      this.fine = null;
      f = Math.max(0, Math.min(1, (distance - R_MIN) / (R_MAX - R_MIN)));
    }
    this.value.set(this.fromFraction(f));
  }

  /** Step the value, from where it is within the range. */
  private nudge(steps: number): void {
    const current = Math.max(this.min(), Math.min(this.max(), this.value()));
    // On a log or area scale, steps grow with the value, so the circle moves
    // evenly; on a linear one they are the step.
    const knee = this.knee();
    const grows = knee !== null || this.mode() === 'area';
    const base = knee ?? this.max() / 100;
    const step = grows
      ? Math.max(this.step(), this.snap((current - this.min() + base) * 0.1))
      : this.step();
    let next = this.clamp(this.snap(current + steps * step));
    // A step too small to survive snapping still moves by one.
    if (next === current && current !== (steps > 0 ? this.max() : this.min())) {
      next = this.clamp(this.snap(current + Math.sign(steps) * this.step()));
    }
    this.value.set(next);
  }

  /** Where a value sits along the circle's travel, from 0 to 1. */
  private toFraction(v: number): number {
    const span = this.max() - this.min();
    if (span <= 0) return 0;
    const t = Math.max(0, Math.min(1, (v - this.min()) / span));
    const knee = this.knee();
    if (knee !== null && knee > 0) {
      return Math.log1p((t * span) / knee) / Math.log1p(span / knee);
    }
    return this.mode() === 'area' ? Math.sqrt(t) : t;
  }

  /** The value at a fraction of the circle's travel. */
  private fromFraction(f: number): number {
    const span = this.max() - this.min();
    const knee = this.knee();
    let t: number;
    if (knee !== null && knee > 0) {
      t = (knee * Math.expm1(f * Math.log1p(span / knee))) / span;
    } else {
      t = this.mode() === 'area' ? f * f : f;
    }
    return this.clamp(this.snap(this.min() + t * span));
  }

  private snap(v: number): number {
    const step = this.step();
    const snapped = Math.round(v / step) * step;
    // Drop floating-point dust (0.30000000000000004).
    return Number(snapped.toFixed(6));
  }

  private clamp(v: number): number {
    return Math.max(this.min(), Math.min(this.max(), v));
  }

  private format(v: number): string {
    if (v >= 10000) return `${Math.round(v / 1000)}k`;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }
}

/** 1, 2, 5, 10, 20, 50… strictly between `min` and `max`. */
function niceValues(min: number, max: number): number[] {
  const values: number[] = [];
  if (max <= min) return values;
  const low = Math.max(min, 1e-3);
  for (let p = Math.floor(Math.log10(low)); 10 ** p <= max; p++) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** p).toFixed(6));
      if (v > min && v < max) values.push(v);
    }
  }
  return values;
}
