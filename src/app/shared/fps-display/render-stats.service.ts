// Timing probes shown in the FPS overlay: the webview engine, whether labels
// are composited on the GPU or the CPU, and how long a full redraw and a
// label composite take. Recording is gated by `enabled`.

import { Injectable } from '@angular/core';

export type CompositeBackend = 'WebGPU' | 'CPU' | '—';

/** Fixed-size rolling window. */
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
  public enabled = false;

  /** The path the last label composite ran on. */
  public compositeBackend: CompositeBackend = '—';

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

/** The webview engine, guessed from the user agent: Tauri uses a different
 *  one on each OS. */
function detectWebview(): string {
  const ua = navigator.userAgent;
  if (/Edg\/|Chrome\//.test(ua)) return 'WebView2 (Chromium)';
  if (/AppleWebKit/.test(ua)) {
    if (/Macintosh|Mac OS X/.test(ua)) return 'WKWebView (macOS)';
    if (/Linux/.test(ua)) return 'WebKitGTK (Linux)';
    return 'WebKit';
  }
  return ua.slice(0, 40);
}
