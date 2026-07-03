// render-stats.service.ts
//
// Lightweight perf probes surfaced through the FPS overlay. The point is to
// make the Windows-vs-macOS/Linux gap measurable: which webview engine is
// running, whether label compositing is on the GPU or CPU path, and how long
// the two heavy per-interaction operations (full redraw, label composite)
// actually take.
//
// Recording is gated behind `enabled` so the probes cost nothing when the
// overlay is hidden. The FpsDisplayComponent flips `enabled` on/off with its
// own lifecycle (it only exists while the counter is shown).

import { Injectable } from '@angular/core';

export type CompositeBackend = 'WebGPU' | 'CPU' | '—';

/** Fixed-size rolling window; avg smooths jitter, max surfaces stalls. */
class Rolling {
  private buf: number[] = [];
  constructor(private cap = 30) {}
  add(v: number) {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }
  get avg(): number {
    if (!this.buf.length) return 0;
    return this.buf.reduce((a, b) => a + b, 0) / this.buf.length;
  }
  get max(): number {
    return this.buf.length ? Math.max(...this.buf) : 0;
  }
  clear() {
    this.buf = [];
  }
}

@Injectable({ providedIn: 'root' })
export class RenderStatsService {
  /** Gate so instrumentation is free when the overlay isn't mounted. */
  public enabled = false;

  /** Which path actually ran on the last label composite. */
  public compositeBackend: CompositeBackend = '—';

  /** Best-effort webview identification, resolved once. */
  public readonly webview = detectWebview();

  private redraw = new Rolling();
  private composite = new Rolling();

  recordRedraw(ms: number) {
    if (this.enabled) this.redraw.add(ms);
  }
  recordComposite(ms: number) {
    if (this.enabled) this.composite.add(ms);
  }

  get redrawMs(): number {
    return this.redraw.avg;
  }
  get redrawMaxMs(): number {
    return this.redraw.max;
  }
  get compositeMs(): number {
    return this.composite.avg;
  }

  reset() {
    this.redraw.clear();
    this.composite.clear();
  }
}

/**
 * Tauri swaps the underlying webview per OS, which is the main reason the same
 * canvas code feels different across platforms. We can't query the engine
 * directly, but the user-agent is a reliable enough proxy.
 */
function detectWebview(): string {
  const ua = navigator.userAgent;
  // WebView2 reports as Chrome/Edg; nothing else Chromium ships in Tauri.
  if (/Edg\/|Chrome\//.test(ua)) return 'WebView2 (Chromium)';
  if (/AppleWebKit/.test(ua)) {
    if (/Macintosh|Mac OS X/.test(ua)) return 'WKWebView (macOS)';
    if (/Linux/.test(ua)) return 'WebKitGTK (Linux)';
    return 'WebKit';
  }
  return ua.slice(0, 40);
}
