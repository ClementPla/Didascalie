
const BUFFER_INDEX = {
  MAIN_THREAD_TIMESTAMP: 0,
  FPS: 1,
  FRAME_TIME: 2,
  FROZEN: 3,
};

let sharedBuffer: Float64Array;
let lastMainThreadTimestamp = 0;
let frameCount = 0;
let lastFpsUpdate = performance.now();

self.onmessage = (event) => {
  if (event.data.type === 'init') {
    sharedBuffer = new Float64Array(event.data.buffer);
    tick();
  }
};

function tick() {
  const now = performance.now();
  const mainThreadTimestamp = sharedBuffer[BUFFER_INDEX.MAIN_THREAD_TIMESTAMP];

  // Check if main thread is frozen (no update for > 100ms)
  const timeSinceMainUpdate = now - mainThreadTimestamp;
  const isFrozen = timeSinceMainUpdate > 100;
  sharedBuffer[BUFFER_INDEX.FROZEN] = isFrozen ? 1 : 0;

  // Calculate FPS based on main thread heartbeats
  if (mainThreadTimestamp !== lastMainThreadTimestamp) {
    frameCount++;
    const frameTime = mainThreadTimestamp - lastMainThreadTimestamp;
    sharedBuffer[BUFFER_INDEX.FRAME_TIME] = frameTime;
    lastMainThreadTimestamp = mainThreadTimestamp;
  }

  // Update FPS every 100ms
  const elapsed = now - lastFpsUpdate;
  if (elapsed >= 100) {
    const fps = (frameCount * 1000) / elapsed;
    sharedBuffer[BUFFER_INDEX.FPS] = Math.round(fps);
    frameCount = 0;
    lastFpsUpdate = now;

    // Post update to main thread (for UI update)
    self.postMessage({
      type: 'metrics',
      fps: sharedBuffer[BUFFER_INDEX.FPS],
      frameTime: sharedBuffer[BUFFER_INDEX.FRAME_TIME],
      frozen: isFrozen,
      frozenFor: isFrozen ? Math.round(timeSinceMainUpdate) : 0,
    });
  }

  setTimeout(tick, 16); // ~60Hz check rate in worker
}