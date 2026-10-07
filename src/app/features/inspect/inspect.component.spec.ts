import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';

import { api, Sequence } from '../../lib/api';
import { IOService } from '../../services/io.service';
import { LabelsService } from '../../services/labels/labels.service';
import { SequenceService } from '../../services/sequence.service';
import { UIStateService } from '../../services/uistate.service';
import { InspectComponent } from './inspect.component';
import { InspectionService } from './inspection.service';
import { makeFrames, solidOverlay, solidPng, until } from './testing';

/** Three sequences of 6, 4 and 5 frames; frame ids are `sequence*100 + index`. */
const SEQUENCES: Sequence[] = [
  { id: 1, name: 'alpha', frameCount: 6, sortOrder: 0 },
  { id: 2, name: 'beta', frameCount: 4, sortOrder: 1 },
  { id: 3, name: 'gamma', frameCount: 5, sortOrder: 2 },
];
const SIZE = 16;

describe('InspectComponent', () => {
  let fixture: ComponentFixture<InspectComponent>;
  let component: InspectComponent;
  let inspection: InspectionService;
  let sequences: SequenceService;
  let navigateToEditor: jasmine.Spy;
  let overlays: jasmine.Spy;
  let png: ArrayBuffer;

  const paneCanvas = (index: number) =>
    fixture.nativeElement.querySelectorAll('canvas')[index] as HTMLCanvasElement;
  /** RGBA at the centre of a pane, where the fitted image always is. */
  const centrePixel = (index: number) => {
    const canvas = paneCanvas(index);
    return Array.from(
      canvas
        .getContext('2d')!
        .getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data,
    );
  };
  const allPanesShow = (frame: number) =>
    component.panes().length > 0 &&
    component.panes().every((p) => p.isReady(frame) && !p.waiting());

  /** Create the panel and wait until it shows its first frame. */
  async function start(): Promise<void> {
    fixture = TestBed.createComponent(InspectComponent);
    component = fixture.componentInstance;
    const host = fixture.nativeElement as HTMLElement;
    host.style.display = 'block';
    host.style.width = '800px';
    host.style.height = '600px';
    fixture.autoDetectChanges();
    await until(() => component.ready(), 'the panel to start');
    if (component.sequenceIds().length > 0) {
      await until(() => allPanesShow(component.frame()), 'the first frame');
    }
  }

  beforeAll(async () => {
    png = await solidPng(SIZE, SIZE, '#000000');
  });

  beforeEach(() => {
    spyOn(api, 'listSequences').and.callFake(async () => SEQUENCES);
    spyOn(api, 'getSequenceFrames').and.callFake(async (id: number) =>
      makeFrames(SEQUENCES.find((s) => s.id === id)!.frameCount, {
        sequenceId: id,
        firstId: id * 100,
        width: SIZE,
        height: SIZE,
      }),
    );
    // What the shared SequenceService loads for the editor's benefit.
    spyOn(api, 'getFrameImage').and.callFake(async (frameId: number) => ({
      frame: makeFrames(1, { firstId: frameId })[0],
      imageBase64: 'data:image/png;base64,',
    }));
    spyOn(api, 'getFramePreview').and.callFake(async () => png.slice(0));
    overlays = spyOn(api, 'renderLabelOverlay').and.callFake(async () =>
      solidOverlay(SIZE, SIZE, [255, 0, 0, 255]),
    );

    navigateToEditor = jasmine.createSpy('navigateToEditor').and.resolveTo(true);
    TestBed.configureTestingModule({
      imports: [InspectComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        { provide: IOService, useValue: { saveIfDirty: async () => true } },
        { provide: UIStateService, useValue: { navigateToEditor } },
      ],
    });

    TestBed.inject(LabelsService).listSegmentationLabels = [
      { id: 7, label: 'vessel', color: '#ff0000', isVisible: true, shades: null },
    ];
    inspection = TestBed.inject(InspectionService);
    sequences = TestBed.inject(SequenceService);
    spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
  });

  afterEach(() => {
    fixture?.destroy();
    TestBed.inject(LabelsService).listSegmentationLabels = [];
    inspection.edgesOnly.set(false);
  });

  it('opens on the current sequence when none was asked for', async () => {
    await start();

    expect(component.sequenceIds()).toEqual([1]);
    expect(component.length()).toBe(6);
    expect(fixture.nativeElement.querySelectorAll('app-inspect-pane').length).toBe(1);
  });

  it('draws the frame with its labels at the chosen opacity', async () => {
    inspection.labelOpacity.set(0.5);
    await start();

    // A black image under a half-transparent red label.
    const [r, g, b, a] = centrePixel(0);
    expect(r).toBeGreaterThan(110);
    expect(r).toBeLessThan(145);
    expect([g, b, a]).toEqual([0, 0, 255]);

    inspection.labelOpacity.set(0);
    await fixture.whenStable();
    expect(centrePixel(0)).toEqual([0, 0, 0, 255]);
  });

  it('asks for the project labels with their palettes', async () => {
    await start();

    const [, , labels] = overlays.calls.mostRecent().args;
    expect(labels.length).toBe(1);
    expect(labels[0].id).toBe(7);
    expect(labels[0].palette.length).toBe(256 * 4);
    expect(labels[0].palette.slice(4, 8)).toEqual([255, 0, 0, 255]);
  });

  it('stops drawing a label that is hidden', async () => {
    inspection.labelOpacity.set(1);
    await start();
    expect(centrePixel(0)).toEqual([255, 0, 0, 255]);

    overlays.calls.reset();
    component.toggleLabel(7);
    await fixture.whenStable();
    await until(() => allPanesShow(0), 'the frame without labels');

    expect(overlays).not.toHaveBeenCalled();
    expect(centrePixel(0)).toEqual([0, 0, 0, 255]);
  });

  it('asks for outlines when showing only edges', async () => {
    await start();
    expect(overlays.calls.mostRecent().args[3]).toBeFalse();

    overlays.calls.reset();
    inspection.edgesOnly.set(true);
    await fixture.whenStable();
    await until(() => allPanesShow(0), 'the outlined frame');

    expect(overlays.calls.count()).toBeGreaterThan(0);
    expect(overlays.calls.allArgs().every((args) => args[3] === true)).toBeTrue();
  });

  it('plays through the sequence and stops at the end when not looping', async () => {
    inspection.loop.set(false);
    inspection.fps.set(60);
    await start();

    component.play();
    expect(component.playing()).toBeTrue();
    await until(() => !component.playing(), 'playback to reach the end');

    expect(component.frame()).toBe(5);
  });

  it('wraps around when looping', async () => {
    inspection.loop.set(true);
    inspection.fps.set(60);
    await start();
    component.seek(4);

    component.play();
    await until(() => component.frame() < 4, 'playback to wrap');
    component.pause();

    expect(component.playing()).toBeFalse();
  });

  it('waits for a frame instead of skipping it', async () => {
    inspection.loop.set(false);
    inspection.fps.set(60);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    (api.getFramePreview as jasmine.Spy).and.callFake(async (id: number) => {
      if (id === 103) await gate;
      return png.slice(0);
    });
    fixture = TestBed.createComponent(InspectComponent);
    component = fixture.componentInstance;
    (fixture.nativeElement as HTMLElement).style.cssText =
      'display:block;width:800px;height:600px';
    fixture.autoDetectChanges();
    await until(() => component.ready() && allPanesShow(0), 'the first frame');

    component.play();
    await until(() => component.buffering(), 'playback to stall');
    expect(component.frame()).toBe(2);

    release();
    await until(() => !component.playing(), 'playback to reach the end');
    expect(component.frame()).toBe(5);
  });

  it('steps one frame at a time, pausing playback', async () => {
    inspection.loop.set(true);
    await start();

    component.step(1);
    expect(component.frame()).toBe(1);
    component.step(-1);
    component.step(-1);
    expect(component.frame()).toBe(5);
    expect(component.playing()).toBeFalse();
  });

  it('moves to the next sequence and makes it the current one', async () => {
    await start();
    component.seek(3);

    expect(component.canStepSequence(-1)).toBeFalse();
    component.stepSequence(1);
    await until(() => sequences.currentSequence()?.id === 2, 'sequence 2 to be shared');

    expect(component.sequenceIds()).toEqual([2]);
    expect(component.frame()).toBe(0);
    await until(() => component.length() === 4, 'the new sequence to load');
  });

  it('shows the sequences it was asked to compare, side by side', async () => {
    await inspection.open([2, 3]);
    await start();

    expect(component.sequenceIds()).toEqual([2, 3]);
    expect(fixture.nativeElement.querySelectorAll('app-inspect-pane').length).toBe(2);
    expect(component.length()).toBe(5);
    // The focused pane is the sequence the rest of the app follows.
    await until(() => sequences.currentSequence()?.id === 2, 'sequence 2 to be shared');
  });

  it('holds the last frame of a shorter sequence', async () => {
    await inspection.open([2, 3]);
    await start();

    component.seek(4);
    await fixture.whenStable();

    expect(component.panes()[0].localIndex()).toBe(3);
    expect(component.panes()[1].localIndex()).toBe(4);
  });

  it('skips sequences already on screen when stepping the focused pane', async () => {
    await inspection.open([1, 2]);
    await start();

    component.stepSequence(1);
    expect(component.sequenceIds()).toEqual([3, 2]);
    expect(component.canStepSequence(1)).toBeFalse();
  });

  it('follows the current sequence in its focused pane when reopened', async () => {
    // Left on [2, 3] earlier; the editor has since moved to sequence 1.
    inspection.sequenceIds.set([2, 3]);
    inspection.focused.set(1);
    await sequences.loadSequences();

    await start();

    expect(component.sequenceIds()).toEqual([2, 1]);
  });

  it('moves the other panes when one is zoomed, if views are synced', async () => {
    await inspection.open([1, 2]);
    await start();
    const [first, second] = component.panes();

    component.onViewChanged(0, { zoom: 3, cx: 0.25, cy: 0.75 });
    const view = second.relativeView()!;
    expect(view.zoom).toBeCloseTo(3, 5);
    expect(view.cx).toBeCloseTo(0.25, 5);
    expect(view.cy).toBeCloseTo(0.75, 5);
    expect(first.relativeView()!.zoom).toBeCloseTo(1, 5);

    inspection.syncViews.set(false);
    component.onViewChanged(0, { zoom: 5, cx: 0.5, cy: 0.5 });
    expect(second.relativeView()!.zoom).toBeCloseTo(3, 5);
  });

  it('removes a pane and keeps the focus on a remaining one', async () => {
    await inspection.open([1, 2, 3]);
    await start();
    component.focusPane(2);

    component.closePane(0);

    expect(component.sequenceIds()).toEqual([2, 3]);
    expect(inspection.focused()).toBe(1);
  });

  it('opens the editor on the frame a pane is showing', async () => {
    await start();
    component.seek(4);
    await fixture.whenStable();

    await component.openInEditor(0, component.panes()[0].localIndex());

    expect(sequences.currentSequence()?.id).toBe(1);
    expect(sequences.currentFrameIndex()).toBe(4);
    expect(navigateToEditor).toHaveBeenCalled();
  });

  it('says so when the project has no sequence', async () => {
    (api.listSequences as jasmine.Spy).and.callFake(async () => []);
    await start();

    expect(fixture.nativeElement.textContent).toContain('No sequence to inspect');
  });
});
