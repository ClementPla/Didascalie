import { api } from '../../lib/api';
import {
  OverlayLabel,
  SequenceFrameCache,
  previewDimensions,
} from './frame-cache';
import { makeFrames, solidOverlay, solidPng, until } from './testing';

const LABELS: OverlayLabel[] = [{ id: 1, palette: [] }];
/** 8×8 previews cost 512 bytes a frame; this holds any test sequence whole. */
const PLENTY = 1024 ** 2;
/** Too little for anything but the minimum window of 8 frames. */
const TIGHT = 1;

describe('previewDimensions', () => {
  it('keeps a frame that fits', () => {
    expect(previewDimensions(640, 480, 1024)).toEqual([640, 480]);
  });

  it('treats 0 as no cap', () => {
    expect(previewDimensions(8000, 6000, 0)).toEqual([8000, 6000]);
  });

  it('scales a large frame on its longest side', () => {
    expect(previewDimensions(4000, 2000, 1000)).toEqual([1000, 500]);
    expect(previewDimensions(2000, 4000, 1000)).toEqual([500, 1000]);
  });
});

describe('SequenceFrameCache', () => {
  let png: ArrayBuffer;
  let previews: jasmine.Spy;
  let overlays: jasmine.Spy;
  let cache: SequenceFrameCache | null;

  /** Indices currently decoded, in order. */
  const cachedOf = (c: SequenceFrameCache) =>
    Array.from({ length: c.length }, (_, i) => i).filter((i) => !!c.get(i));
  /** Frame ids asked for so far (frame id = index + 1), in request order. */
  const requested = () => previews.calls.allArgs().map(([id]) => id as number);

  beforeAll(async () => {
    png = await solidPng(8, 8, '#808080');
  });

  beforeEach(() => {
    cache = null;
    previews = spyOn(api, 'getFramePreview').and.callFake(async () =>
      png.slice(0),
    );
    overlays = spyOn(api, 'renderLabelOverlay').and.callFake(async () =>
      solidOverlay(8, 8, [255, 0, 0, 255]),
    );
  });

  afterEach(() => cache?.dispose());

  it('ends up holding a sequence that fits the budget whole', async () => {
    cache = new SequenceFrameCache(makeFrames(12), 0, LABELS, false, PLENTY, false);
    cache.setPlayhead(5);
    await until(() => cachedOf(cache!).length === 12, 'all frames');

    // The playhead is fetched first, whatever else is.
    expect(requested()[0]).toBe(6);
    expect(cache.get(5)!.overlay).not.toBeNull();
  });

  it('keeps a window around the playhead, mostly ahead of it', async () => {
    cache = new SequenceFrameCache(makeFrames(30), 0, LABELS, false, TIGHT, false);
    cache.setPlayhead(10);
    await until(() => cachedOf(cache!).length === 8, 'the window');

    // 8 frames: the playhead, 6 ahead, 1 behind.
    expect(cachedOf(cache)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it('evicts what the window leaves behind', async () => {
    cache = new SequenceFrameCache(makeFrames(30), 0, LABELS, false, TIGHT, false);
    cache.setPlayhead(0);
    await until(() => cachedOf(cache!).length === 7, 'the first window');
    const first = cache.get(0)!.image;

    cache.setPlayhead(20);
    await until(() => !!cache!.get(26), 'the second window');

    expect(cachedOf(cache)).toEqual([19, 20, 21, 22, 23, 24, 25, 26]);
    // Evicted bitmaps are released, not just forgotten.
    expect(first.width).toBe(0);
  });

  it('keeps the pinned frame through a window change', async () => {
    cache = new SequenceFrameCache(makeFrames(30), 0, LABELS, false, TIGHT, false);
    cache.setPlayhead(0);
    await until(() => !!cache!.get(0), 'frame 0');

    cache.pin(0);
    cache.setPlayhead(20);
    await until(() => !!cache!.get(26), 'the second window');

    expect(cache.get(0)).toBeDefined();
  });

  it('wraps the window past the end when looping', async () => {
    cache = new SequenceFrameCache(makeFrames(30), 0, LABELS, false, TIGHT, true);
    cache.setPlayhead(28);
    await until(() => cachedOf(cache!).length === 8, 'the window');

    expect(cachedOf(cache)).toEqual([0, 1, 2, 3, 4, 27, 28, 29]);
  });

  it('does not look past the end when not looping', async () => {
    cache = new SequenceFrameCache(makeFrames(30), 0, LABELS, false, TIGHT, false);
    cache.setPlayhead(28);
    await until(() => cachedOf(cache!).length === 3, 'the window');

    expect(cachedOf(cache)).toEqual([27, 28, 29]);
  });

  it('reports a frame that cannot be loaded as ready, and does not retry it', async () => {
    spyOn(console, 'error');
    previews.and.callFake(async (id: number) => {
      if (id === 3) throw new Error('unreadable');
      return png.slice(0);
    });
    const ready: number[] = [];
    cache = new SequenceFrameCache(makeFrames(5), 0, LABELS, false, PLENTY, false);
    cache.onFrameReady = (i) => ready.push(i);
    cache.setPlayhead(0);
    await until(() => ready.length === 5, 'every frame to settle');

    expect(cache.isReady(2)).toBeTrue();
    expect(cache.get(2)).toBeUndefined();
    cache.setPlayhead(2);
    await until(() => cachedOf(cache!).length === 4, 'the rest');
    expect(requested().filter((id) => id === 3).length).toBe(1);
  });

  it('holds no overlay for a frame with nothing to draw', async () => {
    overlays.and.callFake(async () => new ArrayBuffer(0));
    cache = new SequenceFrameCache(makeFrames(2), 0, LABELS, false, PLENTY, false);
    cache.setPlayhead(0);
    await until(() => !!cache!.get(0), 'frame 0');

    expect(cache.get(0)!.overlay).toBeNull();
  });

  it('skips the overlay request when there is no label to draw', async () => {
    cache = new SequenceFrameCache(makeFrames(2), 0, [], false, PLENTY, false);
    cache.setPlayhead(0);
    await until(() => !!cache!.get(0), 'frame 0');

    expect(overlays).not.toHaveBeenCalled();
    expect(cache.get(0)!.overlay).toBeNull();
  });

  it('redraws every frame when the labels or their style change', async () => {
    cache = new SequenceFrameCache(makeFrames(3), 0, LABELS, false, PLENTY, false);
    cache.setPlayhead(0);
    await until(() => cachedOf(cache!).length === 3, 'all frames');
    overlays.calls.reset();

    const next: OverlayLabel[] = [{ id: 2, palette: [] }];
    cache.setOverlay(next, true);
    expect(cache.isReady(0)).toBeFalse();
    await until(() => cachedOf(cache!).length === 3, 'all frames again');

    expect(overlays.calls.count()).toBe(3);
    expect(overlays.calls.argsFor(0)[2]).toBe(next);
    expect(overlays.calls.argsFor(0)[3]).toBeTrue();
  });

  it('drops a frame that arrives after the cache was disposed', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    previews.and.callFake(async () => {
      await gate;
      return png.slice(0);
    });
    const ready: number[] = [];
    const disposed = new SequenceFrameCache(makeFrames(2), 0, [], false, PLENTY, false);
    disposed.onFrameReady = (i) => ready.push(i);
    disposed.setPlayhead(0);
    disposed.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(ready).toEqual([]);
    expect(disposed.get(0)).toBeUndefined();
  });
});
