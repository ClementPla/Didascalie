import { Injectable, NgZone, inject } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export interface FpsMetrics {
  fps: number;
  frameTime: number;
  frozen: boolean;
  frozenFor: number; // ms the main thread has been frozen
}

const BUFFER_INDEX = {
  MAIN_THREAD_TIMESTAMP: 0,
  FPS: 1,
  FRAME_TIME: 2,
  FROZEN: 3,
};

@Injectable({ providedIn: 'root' })
export class FpsWorkerService {
  private ngZone = inject(NgZone);

  private metrics$ = new BehaviorSubject<FpsMetrics>({
    fps: 0,
    frameTime: 0,
    frozen: false,
    frozenFor: 0,
  });

  public metrics = this.metrics$.asObservable();

  private worker: Worker | null = null;
  private sharedBuffer: Float64Array | null = null;
  private rafId: number | null = null;
  private started = false;

  async start(): Promise<boolean> {
    if (this.started) return true;

    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('SharedArrayBuffer not available, falling back to simple FPS counter');
      this.startFallback();
      return false;
    }

    try {
      const sab = new SharedArrayBuffer(Float64Array.BYTES_PER_ELEMENT * 4);
      this.sharedBuffer = new Float64Array(sab);

      this.worker = new Worker(
        new URL('./fps-worker.ts', import.meta.url),
        { type: 'module' }
      );

      this.worker.onmessage = (event) => {
        if (event.data.type === 'metrics') {
          this.ngZone.run(() => {
            this.metrics$.next({
              fps: event.data.fps,
              frameTime: event.data.frameTime,
              frozen: event.data.frozen,
              frozenFor: event.data.frozenFor,
            });
          });
        }
      };

      this.worker.postMessage({ type: 'init', buffer: sab });

      this.startHeartbeat();
      this.started = true;
      return true;
    } catch (error) {
      console.error('Failed to start FPS worker:', error);
      this.startFallback();
      return false;
    }
  }

  private startHeartbeat() {
    const heartbeat = () => {
      if (this.sharedBuffer) {
        this.sharedBuffer[BUFFER_INDEX.MAIN_THREAD_TIMESTAMP] = performance.now();
      }
      this.rafId = requestAnimationFrame(heartbeat);
    };
    heartbeat();
  }

  private startFallback() {
    // Without a worker.
    let frameCount = 0;
    let lastTime = performance.now();
    let lastFrameTime = performance.now();

    const tick = () => {
      const now = performance.now();
      const frameTime = now - lastFrameTime;
      lastFrameTime = now;
      frameCount++;

      const elapsed = now - lastTime;
      if (elapsed >= 500) {
        this.ngZone.run(() => {
          this.metrics$.next({
            fps: Math.round((frameCount * 1000) / elapsed),
            frameTime,
            frozen: false,
            frozenFor: 0,
          });
        });
        frameCount = 0;
        lastTime = now;
      }

      this.rafId = requestAnimationFrame(tick);
    };
    tick();
    this.started = true;
  }

  stop() {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.sharedBuffer = null;
    this.started = false;
  }
}