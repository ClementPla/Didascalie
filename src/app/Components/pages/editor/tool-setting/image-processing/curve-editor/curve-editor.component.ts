import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import {
  CurveNode,
  CurvePoints,
  IDENTITY_CURVE,
  sampleCurve,
} from '../../../drawable-canvas/service/image-adjustment/image-processing.model';

@Component({
  selector: 'app-curve-editor',
  standalone: true,
  templateUrl: './curve-editor.component.html',
  styleUrl: './curve-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CurveEditorComponent
  implements AfterViewInit, OnChanges, OnDestroy
{
  @Input() curve: CurvePoints = IDENTITY_CURVE.map((p) => ({ ...p }));
  @Input() histogram: Uint32Array | null = null;
  /** Color for the curve line + selected node (channel tint). */
  @Input() color: string = '#e0e0e0';
  /** Show grid lines. */
  @Input() showGrid: boolean = true;

  @Output() curveChange = new EventEmitter<CurvePoints>();

  @ViewChild('canvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  private ctx!: CanvasRenderingContext2D;
  private dpr = Math.max(1, window.devicePixelRatio || 1);

  // Logical drawing area in CSS px. Set in ngAfterViewInit and on resize.
  private cssWidth = 256;
  private cssHeight = 256;

  // Interaction state
  private draggingIndex: number | null = null;
  private dragStart: { x: number; y: number } | null = null;
  private hoverIndex: number | null = null;
  private resizeObserver?: ResizeObserver;
  private readonly nodeRadius = 5;
  private readonly hitRadius = 10;
  private readonly minNodes = 2;
  private readonly maxNodes = 16;

  ngAfterViewInit() {
    this.ctx = this.canvasRef.nativeElement.getContext('2d')!;

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeCanvas();
      this.redraw();
    });
    this.resizeObserver.observe(this.canvasRef.nativeElement);

    // Initial sync if the element already has a size (active tab).
    this.resizeCanvas();
    this.redraw();
  }
  ngOnDestroy() {
    this.resizeObserver?.disconnect();
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
  }

  ngOnChanges(c: SimpleChanges) {
    if (this.ctx) this.redraw();
  }

  @HostListener('window:resize')
  onWindowResize() {
    this.resizeCanvas();
    this.redraw();
  }

  private resizeCanvas() {
    const el = this.canvasRef.nativeElement;
    const rect = el.getBoundingClientRect();
    // Bail silently when the panel is hidden; the observer will fire again
    // when it becomes visible.
    if (rect.width === 0 || rect.height === 0) return;

    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    el.width = Math.round(this.cssWidth * this.dpr);
    el.height = Math.round(this.cssHeight * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // ==========================================
  // Coordinate transforms (curve space 0..255 ↔ canvas CSS px)
  // ==========================================

  private curveToCanvas(p: CurveNode): { cx: number; cy: number } {
    return {
      cx: (p.x / 255) * this.cssWidth,
      cy: (1 - p.y / 255) * this.cssHeight, // y inverted: high values at top
    };
  }

  private canvasToCurve(cx: number, cy: number): CurveNode {
    const x = Math.round(clamp((cx / this.cssWidth) * 255, 0, 255));
    const y = Math.round(clamp((1 - cy / this.cssHeight) * 255, 0, 255));
    return { x, y };
  }

  // ==========================================
  // Mouse handling
  // ==========================================

  onMouseDown(event: MouseEvent) {
    const { offsetX, offsetY } = this.localCoords(event);
    const hit = this.hitTestNode(offsetX, offsetY);

    if (hit !== null) {
      // Begin drag
      this.draggingIndex = hit;
      this.dragStart = { x: offsetX, y: offsetY };
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
    } else if (event.button === 0 && this.curve.length < this.maxNodes) {
      // Add new node
      const newNode = this.canvasToCurve(offsetX, offsetY);
      const sorted = [...this.curve, newNode].sort((a, b) => a.x - b.x);
      this.curve = sorted;
      this.draggingIndex = sorted.findIndex(
        (p) => p.x === newNode.x && p.y === newNode.y,
      );
      this.dragStart = { x: offsetX, y: offsetY };
      window.addEventListener('mousemove', this.onWindowMouseMove);
      window.addEventListener('mouseup', this.onWindowMouseUp);
      this.emit();
      this.redraw();
    }
  }

  onDoubleClick(event: MouseEvent) {
    const { offsetX, offsetY } = this.localCoords(event);
    const hit = this.hitTestNode(offsetX, offsetY);
    if (hit !== null && this.curve.length > this.minNodes) {
      // Don't allow deleting endpoints (preserves the 0/255 boundary)
      if (hit === 0 || hit === this.curve.length - 1) return;
      this.curve = this.curve.filter((_, i) => i !== hit);
      this.emit();
      this.redraw();
    }
  }

  onMouseMove(event: MouseEvent) {
    if (this.draggingIndex !== null) return; // handled by window listener
    const { offsetX, offsetY } = this.localCoords(event);
    const newHover = this.hitTestNode(offsetX, offsetY);
    if (newHover !== this.hoverIndex) {
      this.hoverIndex = newHover;
      this.redraw();
    }
  }

  onMouseLeave() {
    if (this.draggingIndex !== null) return;
    if (this.hoverIndex !== null) {
      this.hoverIndex = null;
      this.redraw();
    }
  }

  private onWindowMouseMove = (event: MouseEvent) => {
    if (this.draggingIndex === null) return;
    const { offsetX, offsetY } = this.localCoords(event);
    const idx = this.draggingIndex;
    const dragged = this.canvasToCurve(offsetX, offsetY);

    // Endpoints: lock x to 0 or 255 (free y)
    if (idx === 0) dragged.x = 0;
    else if (idx === this.curve.length - 1) dragged.x = 255;
    else {
      // Middle nodes: clamp x to stay between neighbors (1 px separation)
      const prev = this.curve[idx - 1].x;
      const next = this.curve[idx + 1].x;
      dragged.x = clamp(dragged.x, prev + 1, next - 1);
    }

    this.curve = this.curve.map((p, i) => (i === idx ? dragged : p));
    this.emit();
    this.redraw();
  };

  private onWindowMouseUp = () => {
    this.draggingIndex = null;
    this.dragStart = null;
    window.removeEventListener('mousemove', this.onWindowMouseMove);
    window.removeEventListener('mouseup', this.onWindowMouseUp);
  };

  private localCoords(event: MouseEvent): { offsetX: number; offsetY: number } {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    return {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
  }

  private hitTestNode(cx: number, cy: number): number | null {
    let best = -1;
    let bestDist = this.hitRadius * this.hitRadius;
    for (let i = 0; i < this.curve.length; i++) {
      const { cx: nx, cy: ny } = this.curveToCanvas(this.curve[i]);
      const dx = nx - cx,
        dy = ny - cy;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best === -1 ? null : best;
  }

  private emit() {
    this.curveChange.emit(this.curve.map((p) => ({ ...p })));
  }

  // ==========================================
  // Rendering
  // ==========================================

  private redraw() {
    if (!this.ctx) return;
    const w = this.cssWidth,
      h = this.cssHeight;
    this.ctx.clearRect(0, 0, w, h);

    // Background
    this.ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    this.ctx.fillRect(0, 0, w, h);

    // Histogram (behind everything else, semi-transparent)
    if (this.histogram) {
      this.drawHistogram(w, h);
    }

    // Grid
    if (this.showGrid) this.drawGrid(w, h);

    // Identity reference line
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(0, h);
    this.ctx.lineTo(w, 0);
    this.ctx.stroke();

    // Curve
    this.drawCurve(w, h);

    // Nodes
    this.drawNodes();
  }

  private drawGrid(w: number, h: number) {
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      const x = (i / 4) * w;
      const y = (i / 4) * h;
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, h);
      this.ctx.moveTo(0, y);
      this.ctx.lineTo(w, y);
    }
    this.ctx.stroke();
  }

  private drawHistogram(w: number, h: number) {
    const hist = this.histogram!;
    let max = 0;
    // Skip pure black/white peaks that dominate vertical scale
    for (let i = 1; i < 255; i++) if (hist[i] > max) max = hist[i];
    if (max === 0) return;

    this.ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    const barW = w / 256;
    for (let i = 0; i < 256; i++) {
      const barH = (hist[i] / max) * h;
      const x = i * barW;
      this.ctx.fillRect(x, h - barH, barW + 0.5, barH);
    }
  }

  private drawCurve(w: number, h: number) {
    const lut = sampleCurve(this.curve);
    this.ctx.strokeStyle = this.color;
    this.ctx.lineWidth = 2;
    this.ctx.beginPath();
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * w;
      const y = (1 - lut[i] / 255) * h;
      if (i === 0) this.ctx.moveTo(x, y);
      else this.ctx.lineTo(x, y);
    }
    this.ctx.stroke();
  }

  private drawNodes() {
    for (let i = 0; i < this.curve.length; i++) {
      const { cx, cy } = this.curveToCanvas(this.curve[i]);
      const isActive = i === this.draggingIndex || i === this.hoverIndex;
      this.ctx.fillStyle = isActive ? this.color : '#1a1a1a';
      this.ctx.strokeStyle = this.color;
      this.ctx.lineWidth = 2;
      this.ctx.beginPath();
      this.ctx.arc(cx, cy, this.nodeRadius, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.stroke();
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
