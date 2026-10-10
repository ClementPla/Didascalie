import { api, Frame } from '../../lib/api';

/** One frame, decoded and ready to draw. */
export interface InspectFrame {
  image: ImageBitmap;
  /** The labels, already coloured; null when the frame has none to show. */
  overlay: ImageBitmap | null;
}

/** A label to draw and the colour of each of its mask values. */
export interface OverlayLabel {
  id: number;
  /** 256 RGBA entries, see `buildLabelPalette`. */
  palette: number[];
}

/** Frames fetched at once. Each is a read, a decode and a composite on the
 *  Rust side. */
const CONCURRENCY = 4;
/** Fewest frames cached, whatever the budget. */
const MIN_FRAMES = 8;
/** Share of a sliding window kept ahead of the playhead. */
const AHEAD_SHARE = 0.75;

/** The size a `width×height` frame is previewed at, as `preview_dimensions`
 *  in `src-tauri/src/commands/inspect.rs`. Used to estimate memory. */
export function previewDimensions(
  width: number,
  height: number,
  maxDim: number,
): [number, number] {
  const longest = Math.max(width, height);
  if (maxDim === 0 || longest <= maxDim) return [width, height];
  const scale = (side: number) =>
    Math.max(1, Math.round((side * maxDim) / longest));
  return [scale(width), scale(height)];
}

/**
 * The decoded frames of one sequence around the playhead, fetched ahead of
 * time. A sequence that fits the memory budget is cached whole; a longer one
 * keeps a window sliding with the playhead, mostly ahead of it.
 *
 * Not reactive: the owner moves the playhead (`setPlayhead`) and is told when
 * a frame lands (`onFrameReady`).
 */
export class SequenceFrameCache {
  /** A frame the owner is waiting for became available. */
  onFrameReady?: (index: number) => void;

  private readonly cached = new Map<number, InspectFrame>();
  private readonly inflight = new Set<number>();
  /** Frames that could not be loaded. Not retried, and reported as ready, so
   *  that playback does not stall. */
  private readonly failed = new Set<number>();

  private playhead = 0;
  /** The frames playback is limited to, both included. Nothing outside is
   *  fetched, apart from the frame the playhead is on. */
  private first = 0;
  private last: number;
  /** A frame kept regardless of the window: the one currently on screen. */
  private pinned: number | null = null;
  private capacity = MIN_FRAMES;
  /** Bumped when what is cached stops being valid: loads started before are
   *  dropped on arrival. */
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly frames: readonly Frame[],
    /** Longest side of a preview, 0 for native. */
    private readonly maxDim: number,
    private labels: OverlayLabel[],
    /** Outline the labelled regions instead of filling them. */
    private edgesOnly: boolean,
    budgetBytes: number,
    /** Whether playback wraps, i.e. the frames after the last are the first. */
    private loop: boolean,
  ) {
    // Not fetching yet: the owner has not said where the playhead is.
    this.capacity = this.capacityFor(budgetBytes);
    this.last = Math.max(0, frames.length - 1);
  }

  get length(): number {
    return this.frames.length;
  }

  get(index: number): InspectFrame | undefined {
    return this.cached.get(index);
  }

  /** `index` can be shown now, or never will be (see `failed`). */
  isReady(index: number): boolean {
    return this.cached.has(index) || this.failed.has(index);
  }

  /** Move the window to `index` and start fetching what it now misses. */
  setPlayhead(index: number): void {
    this.playhead = index;
    this.pump();
  }

  /** Keep `index` cached even once the window has moved past it. */
  pin(index: number | null): void {
    this.pinned = index;
  }

  setLoop(loop: boolean): void {
    if (loop === this.loop) return;
    this.loop = loop;
    this.pump();
  }

  /** Limit playback to the frames `first`..`last` (both included). What lies
   *  outside is dropped. */
  setRange(first: number, last: number): void {
    const end = Math.max(0, this.frames.length - 1);
    const lo = Math.max(0, Math.min(Math.round(first), end));
    const hi = Math.max(lo, Math.min(Math.round(last), end));
    if (lo === this.first && hi === this.last) return;
    this.first = lo;
    this.last = hi;
    this.pump();
  }

  /** Memory this cache may hold, in decoded bytes. */
  setBudget(bytes: number): void {
    this.capacity = this.capacityFor(bytes);
    this.pump();
  }

  /** How many frames fit in `bytes`, decoded. */
  private capacityFor(bytes: number): number {
    const perFrame = this.frames.reduce((max, f) => {
      const [w, h] = previewDimensions(f.width, f.height, this.maxDim);
      // An image and an overlay, RGBA each.
      return Math.max(max, w * h * 4 * 2);
    }, 1);
    return Math.max(MIN_FRAMES, Math.floor(bytes / perFrame));
  }

  /** Draw the labels differently: every cached overlay is now wrong. */
  setOverlay(labels: OverlayLabel[], edgesOnly: boolean): void {
    this.labels = labels;
    this.edgesOnly = edgesOnly;
    this.generation++;
    this.failed.clear();
    this.clear();
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.onFrameReady = undefined;
    this.clear();
  }

  // ── Window ───────────────────────────────────────────────────────────────

  /** The frames worth holding, most urgent first. */
  private wanted(): number[] {
    const count = this.frames.length;
    if (count === 0) return [];
    const order: number[] = [];
    const seen = new Set<number>();
    const keep = (i: number) => {
      if (i < 0 || i >= count || seen.has(i)) return;
      seen.add(i);
      order.push(i);
    };
    const { first, last } = this;
    const span = last - first + 1;
    /** A frame of the range, wrapping around its ends when looping. */
    const add = (index: number) => {
      const i = this.loop
        ? first + ((((index - first) % span) + span) % span)
        : index;
      if (i >= first && i <= last) keep(i);
    };

    // The frame on screen first, even when the range excludes it.
    keep(this.playhead);
    const whole = this.capacity >= span;
    const ahead = whole ? span : Math.floor(this.capacity * AHEAD_SHARE);
    const behind = whole ? span : this.capacity - 1 - ahead;
    for (let d = 1; d <= ahead; d++) add(this.playhead + d);
    for (let d = 1; d <= behind; d++) add(this.playhead - d);
    if (this.pinned !== null) keep(this.pinned);
    return order;
  }

  /** Evict what left the window, and fetch what entered it. */
  private pump(): void {
    if (this.disposed) return;
    const wanted = this.wanted();
    const keep = new Set(wanted);
    for (const [index, frame] of this.cached) {
      if (!keep.has(index)) {
        close(frame);
        this.cached.delete(index);
      }
    }
    for (const index of wanted) {
      if (this.inflight.size >= CONCURRENCY) break;
      if (
        this.cached.has(index) ||
        this.inflight.has(index) ||
        this.failed.has(index)
      ) {
        continue;
      }
      void this.load(index);
    }
  }

  private async load(index: number): Promise<void> {
    const generation = this.generation;
    const frameId = this.frames[index].id;
    this.inflight.add(index);

    let frame: InspectFrame | null = null;
    try {
      const [image, overlay] = await Promise.all([
        api
          .getFramePreview(frameId, this.maxDim)
          .then((bytes) => createImageBitmap(new Blob([bytes]))),
        this.labels.length > 0
          ? api
              .renderLabelOverlay(
                frameId,
                this.maxDim,
                this.labels,
                this.edgesOnly,
              )
              .then(decodeOverlay)
          : null,
      ]);
      frame = { image, overlay };
    } catch (error) {
      console.error(`Failed to load frame ${frameId} for inspection:`, error);
    }

    // A load from before a `setOverlay` / `dispose`.
    if (generation !== this.generation) {
      if (frame) close(frame);
      return;
    }
    this.inflight.delete(index);

    if (!frame) {
      this.failed.add(index);
      this.onFrameReady?.(index);
    } else if (this.wanted().includes(index)) {
      this.cached.set(index, frame);
      this.onFrameReady?.(index);
    } else {
      // The playhead moved on while this was loading.
      close(frame);
    }
    this.pump();
  }

  private clear(): void {
    for (const frame of this.cached.values()) close(frame);
    this.cached.clear();
    this.inflight.clear();
  }
}

function close(frame: InspectFrame): void {
  frame.image.close();
  frame.overlay?.close();
}

/** Turn a `render_label_overlay` reply into a bitmap; null when it is empty. */
async function decodeOverlay(buffer: ArrayBuffer): Promise<ImageBitmap | null> {
  if (buffer.byteLength <= 8) return null;
  const header = new DataView(buffer, 0, 8);
  const width = header.getUint32(0, true);
  const height = header.getUint32(4, true);
  if (width === 0 || height === 0) return null;
  const pixels = new Uint8ClampedArray(buffer, 8, width * height * 4);
  return createImageBitmap(new ImageData(pixels, width, height));
}
