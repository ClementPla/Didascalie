import { Directive, EventEmitter, HostListener, Output } from '@angular/core';
import { ZoomPanService } from '../service/zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { DrawService } from '../service/draw.service';
import { VectorEditorService } from '../service/vector-editor.service';
import { Point2D } from '../interface';

@Directive({
  selector: '[appCanvasInput]',
  standalone: true,
})
export class CanvasInputDirective {
  @Output() canvasMove = new EventEmitter<{
    event: MouseEvent;
    coords: Point2D;   // image space (px, clamped, integer)
    cursor: Point2D;   // viewport space (CSS px)
  }>();
  @Output() canvasUp = new EventEmitter<MouseEvent>();

  // Two-finger pinch state
  private pinchActive = false;
  private lastPinchDist = 0;
  private lastPinchMid: Point2D = { x: 0, y: 0 };

  constructor(
    private zoomPanService: ZoomPanService,
    private editorService: EditorService,
    private drawService: DrawService,
    private vectorEditor: VectorEditorService,
  ) {}

  // ==========================================
  // Mouse
  // ==========================================

  @HostListener('mousedown', ['$event'])
  onMouseDown(event: MouseEvent) {
    this.pointerDown(event);
  }

  @HostListener('mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    this.pointerMove(event);
  }

  @HostListener('mouseup', ['$event'])
  async onMouseUp(event: MouseEvent) {
    await this.pointerUp(event);
  }

  @HostListener('dblclick', ['$event'])
  onDoubleClick(event: MouseEvent) {
    if (event.button !== 0 || !this.editorService.isVectorTool()) return;
    this.vectorEditor.onDoubleClick(
      this.zoomPanService.getImageCoordinatesRaw(event),
    );
  }

  @HostListener('mouseleave', ['$event'])
  async onMouseLeave(event: MouseEvent) {
    // Cursor left the canvas: keyboard zoom falls back to the viewport center.
    this.zoomPanService.lastCursorViewport = null;
    await this.pointerUp(event);
  }

  // ==========================================
  // Pressure
  // ==========================================
  // Pointer events fire alongside the mouse/touch listeners above; here they
  // only record pressure (they never start a stroke), so the drawing pipeline
  // is untouched while the pen tool can scale its radius by pressure.

  @HostListener('pointerdown', ['$event'])
  onPointerDownPressure(event: PointerEvent) {
    this.recordPressure(event);
  }

  @HostListener('pointermove', ['$event'])
  onPointerMovePressure(event: PointerEvent) {
    this.recordPressure(event);
  }

  private recordPressure(event: PointerEvent) {
    if (event.pointerType === 'mouse') {
      // Mouse has no real pressure (constant 0.5 while pressed) — no scaling.
      this.editorService.strokeIsPressure = false;
      this.editorService.strokePressure = 1;
    } else {
      // Pen/touch: pressure in [0, 1]. Some devices report 0; fall back to a
      // neutral mid value so the stroke doesn't collapse to nothing.
      this.editorService.strokeIsPressure = true;
      this.editorService.strokePressure =
        event.pressure > 0 ? event.pressure : 0.5;
    }
  }

  // ==========================================
  // Touch
  // ==========================================

  @HostListener('touchstart', ['$event'])
  onTouchStart(event: TouchEvent) {
    if (event.touches.length >= 2) {
      event.preventDefault();
      // A first finger may have started a stroke — discard it.
      this.cancelActiveStroke();
      this.beginPinch(event);
      return;
    }
    const mouse = this.normalizeEvent(event);
    if (mouse) this.pointerDown(mouse);
  }

  @HostListener('touchmove', ['$event'])
  onTouchMove(event: TouchEvent) {
    event.preventDefault();

    if (event.touches.length >= 2) {
      if (this.pinchActive) this.updatePinch(event);
      else this.beginPinch(event);
      return;
    }

    // A finger was lifted mid-pinch: ignore until all fingers are up so we
    // don't paint an accidental stroke with the remaining finger.
    if (this.pinchActive) return;

    const mouse = this.normalizeEvent(event);
    if (mouse) this.pointerMove(mouse);
  }

  @HostListener('touchend', ['$event'])
  @HostListener('touchcancel', ['$event'])
  async onTouchEnd(event: TouchEvent) {
    if (this.pinchActive) {
      if (event.touches.length === 0) this.pinchActive = false;
      return;
    }
    const mouse = this.normalizeEvent(event);
    if (mouse) await this.pointerUp(mouse);
  }

  // ==========================================
  // Shared pointer logic
  // ==========================================

  private pointerDown(event: MouseEvent) {
    if (event.button === 1) {
      this.editorService.activatePanMode();
    }

    if (this.editorService.canPan()) {
      this.zoomPanService.startDrag(event);
      return;
    }

    // Vector tools route through the editor service instead of the raster pen.
    if (this.editorService.isVectorTool()) {
      if (event.button === 0) {
        this.vectorEditor.onPointerDown(
          this.zoomPanService.getImageCoordinatesRaw(event),
        );
      }
      return;
    }

    this.drawService.startDraw(event);
  }

  private pointerMove(event: MouseEvent) {
    const coords = this.zoomPanService.getImageCoordinates(event);
    const cursor = this.zoomPanService.getViewportCoordinates(event);
    // Remember the cursor so keyboard (+/-) zoom can pivot on it.
    this.zoomPanService.lastCursorViewport = cursor;
    this.canvasMove.emit({ event, coords, cursor });
  }

  private async pointerUp(event: MouseEvent) {
    if (event.button === 1) {
      this.editorService.restoreLastTool();
    }

    this.zoomPanService.endDrag();
    if (this.editorService.canPan()) return;

    if (this.editorService.isVectorTool()) {
      this.vectorEditor.onPointerUp();
      return;
    }

    await this.drawService.endDraw(event);
  }

  // ==========================================
  // Pinch (zoom + pan)
  // ==========================================

  private beginPinch(event: TouchEvent) {
    this.pinchActive = true;
    this.lastPinchDist = this.touchDistance(event);
    this.lastPinchMid = this.touchMidpoint(event);
  }

  private updatePinch(event: TouchEvent) {
    const dist = this.touchDistance(event);
    const mid = this.touchMidpoint(event);

    if (this.lastPinchDist > 0) {
      const factor = dist / this.lastPinchDist;
      const prevMid = this.zoomPanService.getViewportCoordinates(
        this.lastPinchMid,
      );
      const currMid = this.zoomPanService.getViewportCoordinates(mid);
      this.zoomPanService.pinch(prevMid, currMid, factor);
    }

    this.lastPinchDist = dist;
    this.lastPinchMid = mid;
  }

  private cancelActiveStroke() {
    this.zoomPanService.endDrag();
    this.drawService.cancelDraw();
  }

  /** Distance between the first two touches (client px). */
  private touchDistance(event: TouchEvent): number {
    const a = event.touches[0];
    const b = event.touches[1];
    return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
  }

  /** Midpoint of the first two touches (client px). */
  private touchMidpoint(event: TouchEvent): Point2D {
    const a = event.touches[0];
    const b = event.touches[1];
    return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
  }

  // ==========================================
  // Helpers
  // ==========================================

  private isTouchEvent(event: MouseEvent | TouchEvent): event is TouchEvent {
    return typeof TouchEvent !== 'undefined' && event instanceof TouchEvent;
  }

  private normalizeEvent(event: MouseEvent | TouchEvent): MouseEvent | null {
    if (!this.isTouchEvent(event)) return event;
    const touch = event.changedTouches[0] || event.touches[0];
    if (!touch) return null;
    const synthetic = new MouseEvent('normalized', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
    });
    Object.defineProperty(synthetic, 'target', { value: event.target });
    Object.defineProperty(synthetic, 'currentTarget', {
      value: event.currentTarget,
    });
    return synthetic;
  }
}
