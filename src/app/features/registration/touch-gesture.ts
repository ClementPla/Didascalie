/** What two fingers did since the last move: a pan, and a scale about `pivot`. */
export interface PinchStep {
  dx: number;
  dy: number;
  factor: number;
  /** Midpoint of the two fingers, in client coordinates. */
  pivot: { x: number; y: number };
}

/**
 * Follows the fingers on one element and turns two of them into pan + pinch.
 *
 * Feed it every pointer event; it ignores mouse and pen, which keep their
 * desktop behaviour. `multi` stays true from the second finger going down
 * until every finger is lifted, so the finger left over after a pinch is not
 * mistaken for a tap or a drag.
 */
export class TouchGesture {
  private readonly fingers = new Map<number, { x: number; y: number }>();
  private last: { x: number; y: number; dist: number } | null = null;

  multi = false;

  down(event: PointerEvent): void {
    if (event.pointerType !== 'touch') return;
    this.fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.fingers.size >= 2) {
      this.multi = true;
      this.last = this.measure();
    }
  }

  /** The step two fingers just made, or null for anything else. */
  move(event: PointerEvent): PinchStep | null {
    if (!this.fingers.has(event.pointerId)) return null;
    this.fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.fingers.size < 2 || !this.last) return null;

    const now = this.measure();
    const step: PinchStep = {
      dx: now.x - this.last.x,
      dy: now.y - this.last.y,
      factor: this.last.dist > 0 ? now.dist / this.last.dist : 1,
      pivot: { x: now.x, y: now.y },
    };
    this.last = now;
    return step;
  }

  up(event: PointerEvent): void {
    if (!this.fingers.delete(event.pointerId)) return;
    this.last = this.fingers.size >= 2 ? this.measure() : null;
    if (this.fingers.size === 0) this.multi = false;
  }

  /** Midpoint and separation of the first two fingers. */
  private measure(): { x: number; y: number; dist: number } {
    const [a, b] = [...this.fingers.values()];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }
}
