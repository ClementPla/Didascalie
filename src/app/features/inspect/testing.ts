import { Frame } from '../../lib/api';

/** `count` frames of one sequence, ids `firstId`, `firstId + 1`, … */
export function makeFrames(
  count: number,
  { sequenceId = 1, firstId = 1, width = 8, height = 8 } = {},
): Frame[] {
  return Array.from({ length: count }, (_, i) => ({
    id: firstId + i,
    sequenceId,
    frameIndex: i,
    relativePath: `frame-${i}.png`,
    width,
    height,
    reviewed: false,
    isEmbedded: false,
  }));
}

/** An encoded image of one flat colour, as `get_frame_preview` replies. */
export async function solidPng(
  width: number,
  height: number,
  color: string,
): Promise<ArrayBuffer> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

/** A `render_label_overlay` reply covering the frame with one RGBA colour. */
export function solidOverlay(
  width: number,
  height: number,
  rgba: [number, number, number, number],
): ArrayBuffer {
  const buffer = new ArrayBuffer(8 + width * height * 4);
  const header = new DataView(buffer);
  header.setUint32(0, width, true);
  header.setUint32(4, height, true);
  const pixels = new Uint8Array(buffer, 8);
  for (let i = 0; i < width * height; i++) pixels.set(rgba, i * 4);
  return buffer;
}

/** Resolve once `condition` holds; fail the test if it never does. */
export async function until(
  condition: () => boolean,
  what = 'condition',
  timeoutMs = 4000,
): Promise<void> {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
