import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SizeDialComponent, SizeDialMode } from './size-dial.component';

describe('SizeDialComponent', () => {
  let fixture: ComponentFixture<SizeDialComponent>;
  let dial: SizeDialComponent;
  let svg: SVGSVGElement;

  function setUp(
    mode: SizeDialMode,
    value: number,
    min: number,
    max: number,
    step = 1,
    knee: number | null = null,
  ): void {
    fixture = TestBed.createComponent(SizeDialComponent);
    fixture.componentRef.setInput('knee', knee);
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('min', min);
    fixture.componentRef.setInput('max', max);
    fixture.componentRef.setInput('step', step);
    fixture.componentRef.setInput('mode', mode);
    fixture.detectChanges();
    dial = fixture.componentInstance;
    svg = fixture.nativeElement.querySelector('svg');
    svg.style.width = '120px';
  }

  /** A pointer event at this distance from the centre, in drawing units. */
  function pointer(type: string, distance: number, shiftKey = false, pointerType = 'mouse'): void {
    const box = svg.getBoundingClientRect();
    const scale = box.width / 120;
    svg.dispatchEvent(
      new PointerEvent(type, {
        button: 0,
        pointerId: 1,
        shiftKey,
        pointerType,
        clientX: box.left + (60 + distance) * scale,
        clientY: box.top + 60 * scale,
      }),
    );
  }

  function pressAt(distance: number): void {
    pointer('pointerdown', distance);
  }

  function key(k: string): void {
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: k }));
  }

  beforeEach(() => TestBed.configureTestingModule({ imports: [SizeDialComponent] }));

  it('reads a radius from the distance to the centre', () => {
    setUp('radius', 10, 0, 49);
    pressAt(52); // the outer ring
    expect(dial.value()).toBe(49);
    pressAt(3); // the smallest circle
    expect(dial.value()).toBe(0);
    pressAt(27.5); // halfway
    expect(dial.value()).toBe(25);
  });

  it('grows an area as the square of the radius', () => {
    setUp('area', 0, 0, 4000, 10);
    pressAt(27.5); // half the radius: a quarter of the area
    expect(dial.value()).toBe(1000);
  });

  it('steps with the keys and stays in range', () => {
    setUp('radius', 2, 1, 50);
    key('ArrowUp');
    expect(dial.value()).toBe(3);
    key('Home');
    key('ArrowDown');
    expect(dial.value()).toBe(1);
    key('End');
    expect(dial.value()).toBe(50);
  });

  it('snaps to the step without floating-point dust', () => {
    setUp('radius', 0.5, 0.5, 20, 0.5);
    key('ArrowUp');
    key('ArrowUp');
    expect(dial.value()).toBe(1.5);
  });

  it('shows a value beyond its ring as more than the largest', () => {
    setUp('area', 9000, 0, 5000, 10);
    expect(dial.overflow()).toBeTrue();
    expect(dial.display()).toBe('9000+');
  });

  it('gives small values room on a log scale', () => {
    setUp('radius', 1, 1, 50, 1, 2);
    // From the smallest circle, a few units of drag reach 2 px, not 1 unit.
    pressAt(3 + 4);
    expect(dial.value()).toBe(2);
    pressAt(52);
    expect(dial.value()).toBe(50);
  });

  it('moves slower with Shift held', () => {
    setUp('radius', 25, 0, 49);
    pressAt(27.5);
    expect(dial.value()).toBe(25);
    pointer('pointermove', 30, true); // Shift: this move anchors the slow drag
    expect(dial.value()).toBe(25);
    pointer('pointermove', 35, true); // 5 units at a fifth of the speed
    expect(dial.value()).toBe(26);
    pointer('pointermove', 37); // without Shift, back under the pointer
    expect(dial.value()).toBe(34);
  });

  it('labels round values on the guide rings', () => {
    setUp('radius', 1, 1, 50, 1, 2);
    const labels = dial.guides().map((g) => g.value);
    expect(labels.length).toBeGreaterThan(1);
    expect(labels.every((v) => [2, 5, 10, 20].includes(v))).toBeTrue();
  });

  it('waits for a finger to move before it drags', () => {
    setUp('radius', 10, 0, 49);
    pointer('pointerdown', 40, false, 'touch');
    expect(dial.value()).toBe(10); // a tap changes nothing
    expect(dial.touchDrag()).toBeTrue();
    pointer('pointermove', 41, false, 'touch'); // within the slop
    expect(dial.value()).toBe(10);
    pointer('pointermove', 47, false, 'touch');
    expect(dial.value()).toBe(44);
    pointer('pointerup', 47, false, 'touch');
    expect(dial.touchDrag()).toBeFalse();
  });

  it('steps with the − and + buttons', () => {
    setUp('radius', 2, 1, 50);
    const [minus, plus] = fixture.nativeElement.querySelectorAll('.dial__step');
    plus.click();
    expect(dial.value()).toBe(3);
    minus.click();
    minus.click();
    expect(dial.value()).toBe(1);
    fixture.detectChanges();
    expect(minus.disabled).toBeTrue();
  });
});
