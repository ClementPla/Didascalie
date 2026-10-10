import { Tools } from '../../../../core/tools';
import { LONG_PRESS_MS, TAP_SLOP } from '../../../../core/touch';
import { Directive, HostListener, inject, input, output } from '@angular/core';
import { ZoomPanService } from '../service/zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { DrawService } from '../service/draw.service';
import { VectorEditorService } from '../service/vector-editor.service';
import { ConvertService } from '../service/convert.service';
import { Point2D } from '../interface';

@Directive({
  selector: '[appCanvasInput]',
  standalone: true,
})
export class CanvasInputDirective {
  private zoomPanService = inject(ZoomPanService);
  private editorService = inject(EditorService);
  private drawService = inject(DrawService);
  private vectorEditor = inject(VectorEditorService);
  private convertService = inject(ConvertService);

  /**
   * What a press on this canvas may do: everything (`editor`), the raster
   * tools only (`raster`: a canvas with no vector layer), or nothing but
   * moving the view (`view`).
   */
  readonly scope = input<'editor' | 'raster' | 'view'>('editor', {
    alias: 'appCanvasInputScope',
  });

  readonly canvasMove = output<{
    event: MouseEvent;
    coords: Point2D; // image space (px, clamped, integer)
    cursor: Point2D; // viewport space (CSS px)
}>();
  readonly canvasUp = output<MouseEvent>();
  /** Right-click on the canvas, for the label picker. */
  readonly contextMenu = output<MouseEvent>();

  // Two-finger pinch state
  private pinchActive = false;
  private lastPinchDist = 0;
  private lastPinchMid: Point2D = { x: 0, y: 0 };

  // ── Mouse ────────────────────────────────────────────────────────────────

  /** Right-click opens the label picker; the button routing is in `pointerDown`. */
  @HostListener('contextmenu', ['$event'])
  onContextMenu(event: MouseEvent) {
    event.preventDefault();
    // A finger resting on the canvas: Android reports the long press itself.
    if (this.longPressBlocked || this.scope() === 'view') return;
    // A pen held with its side button reports a right click; when the button
    // is bound to something else, that is not a request for the picker.
    if (
      this.penButtonHeld &&
      this.editorService.penButtonEnabled &&
      this.editorService.penButtonAction !== 'picker'
    ) {
      return;
    }
    if (this.longPressAt) this.claimLongPress();
    this.openPicker(event);
  }

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
    if (event.button !== 0 || !this.usesVectorTool()) return;
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

  // ── Pressure ─────────────────────────────────────────────────────────────
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

  @HostListener('pointerup', ['$event'])
  @HostListener('pointercancel', ['$event'])
  onPointerUpPen(event: PointerEvent) {
    if (event.pointerType === 'pen') this.penContact = false;
  }

  /**
   * The pen's side button is down.
   *
   * Read from pointer events: a stroke arrives as touch events, which carry no
   * buttons. On Android it can only be read while the pen *hovers*, where the
   * button shows as bit 1; once the pen touches, bit 1 means contact and the
   * button is no longer reported (`MainActivity` strips it so that the stroke
   * is delivered at all). So the value seen just before contact is kept for the
   * stroke. Bits 2 and 32, a barrel button and an eraser end, are what a
   * desktop tablet reports, during contact too.
   */
  private penButtonHeld = false;
  /** The pen is on the surface, between its `pointerdown` and `pointerup`. */
  private penContact = false;
  /** What the pointer that last went down was: a stroke arrives as touch
   *  events, which do not tell a finger from a pen. */
  private lastPointerType = 'mouse';
  /** The gesture in progress swapped tools (pen button, or a finger panning
   *  in pen-only mode); the tool is put back when it ends. */
  private toolSwapped = false;

  private recordPressure(event: PointerEvent) {
    this.lastPointerType = event.pointerType;
    if (event.pointerType !== 'pen') {
      this.penButtonHeld = false;
    } else {
      if (event.type === 'pointerdown') this.penContact = true;
      this.penButtonHeld = this.penContact
        ? this.penButtonHeld || (event.buttons & (2 | 32)) !== 0
        : (event.buttons & (1 | 2 | 32)) !== 0;
    }
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

  // ── Touch ────────────────────────────────────────────────────────────────

  // A long press stands in for the right click, which a finger does not have.
  // Android's webview raises `contextmenu` for it; the timer below is only a
  // fallback for a webview that does not, and waits long enough to lose.
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private longPressAt: Point2D | null = null;
  /** The press became a long press: ignore that finger until it lifts. */
  private longPressed = false;
  /** When the picker was last opened, so one press cannot open it twice (some
   *  webviews also fire `contextmenu` on a long press). */
  private pickerOpenedAt = 0;
  /** A finger is down with a tool that cannot give its press back. */
  private longPressBlocked = false;

  private armLongPress(touch: Touch) {
    this.disarmLongPress();
    if (this.scope() === 'view') return;
    // Only for tools whose press can be taken back: a vector tool has already
    // placed its node, and the convert tools have already run.
    if (
      this.scope() === 'editor' &&
      (this.editorService.isVectorTool() ||
        this.editorService.isVectorizeTool() ||
        this.editorService.isSkeletonizeTool())
    ) {
      this.longPressBlocked = true;
      return;
    }
    const at = { x: touch.clientX, y: touch.clientY };
    this.longPressAt = at;
    this.longPressTimer = setTimeout(() => {
      this.claimLongPress();
      this.openPicker(
        new MouseEvent('contextmenu', { clientX: at.x, clientY: at.y, button: 2 }),
      );
    }, LONG_PRESS_MS + 350);
  }

  /** The press is a long press: drop the stroke it began and ignore the
   *  finger from here on. */
  private claimLongPress() {
    this.disarmLongPress();
    this.longPressed = true;
    this.cancelActiveStroke();
  }

  private disarmLongPress() {
    if (this.longPressTimer !== null) clearTimeout(this.longPressTimer);
    this.longPressTimer = null;
    this.longPressAt = null;
  }

  private openPicker(event: MouseEvent) {
    const now = performance.now();
    if (now - this.pickerOpenedAt < 800) {
      // A second report of the same press. It must not reach the document:
      // the menu takes a `contextmenu` outside itself as a cue to close.
      event.stopPropagation();
      return;
    }
    this.pickerOpenedAt = now;
    this.contextMenu.emit(event);
  }

  @HostListener('touchstart', ['$event'])
  onTouchStart(event: TouchEvent) {
    if (event.touches.length >= 2) {
      event.preventDefault();
      this.disarmLongPress();
      // A first finger may have started a stroke — discard it.
      this.cancelActiveStroke();
      this.beginPinch(event);
      return;
    }
    this.armLongPress(event.touches[0]);
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
    if (this.pinchActive || this.longPressed) return;

    const start = this.longPressAt;
    const touch = event.touches[0];
    if (
      start &&
      touch &&
      Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > TAP_SLOP
    ) {
      this.disarmLongPress(); // the finger is drawing, not resting
    }

    const mouse = this.normalizeEvent(event);
    if (mouse) this.pointerMove(mouse);
  }

  @HostListener('touchend', ['$event'])
  @HostListener('touchcancel', ['$event'])
  async onTouchEnd(event: TouchEvent) {
    this.disarmLongPress();
    if (event.touches.length === 0) this.longPressBlocked = false;
    if (this.longPressed) {
      if (event.touches.length === 0) this.longPressed = false;
      return;
    }
    if (this.pinchActive) {
      if (event.touches.length === 0) this.pinchActive = false;
      return;
    }
    const mouse = this.normalizeEvent(event);
    if (mouse) await this.pointerUp(mouse);
  }

  // ── Shared pointer logic ─────────────────────────────────────────────────

  /** The same event as a plain left press, for a pen whose side button made
   *  it arrive as a right one. */
  private asLeftPress(event: MouseEvent): MouseEvent {
    const left = new MouseEvent(event.type, {
      clientX: event.clientX,
      clientY: event.clientY,
      button: 0,
    });
    Object.defineProperty(left, 'target', { value: event.target });
    Object.defineProperty(left, 'currentTarget', { value: event.currentTarget });
    return left;
  }

  /** A vector tool is selected and this canvas has a vector layer. */
  private usesVectorTool(): boolean {
    return this.scope() === 'editor' && this.editorService.isVectorTool();
  }

  private pointerDown(event: MouseEvent) {
    if (this.scope() === 'view') {
      if (event.button !== 2) this.zoomPanService.startDrag(event);
      return;
    }
    if (this.penButtonHeld && this.editorService.penButtonEnabled) {
      const action = this.editorService.penButtonAction;
      if (action === 'picker') {
        this.openPicker(
          new MouseEvent('contextmenu', {
            clientX: event.clientX,
            clientY: event.clientY,
            button: 2,
          }),
        );
        return;
      }
      this.editorService.activateTemporaryTool(
        action === 'pan' ? Tools.PAN : Tools.ERASER,
      );
      this.toolSwapped = true;
      event = this.asLeftPress(event);
    } else if (
      this.editorService.penOnlyDrawing &&
      this.lastPointerType === 'touch' &&
      !this.editorService.canPan()
    ) {
      // Pen-only drawing: a finger moves the image instead.
      this.editorService.activateTemporaryTool(Tools.PAN);
      this.toolSwapped = true;
    }

    // The right button belongs to the label picker (see `onContextMenu`), so it
    // must not start a drag or a stroke. The middle button is the opposite case:
    // holding it is how you pan, so it has to reach the pan branch below.
    if (event.button === 2) return;

    if (event.button === 1) {
      this.editorService.activatePanMode();
    }

    if (this.editorService.canPan()) {
      this.zoomPanService.startDrag(event);
      return;
    }

    // Tools that need the vector layer do nothing on a raster-only canvas.
    if (
      this.scope() !== 'editor' &&
      (this.editorService.isVectorTool() ||
        this.editorService.isVectorizeTool() ||
        this.editorService.isSkeletonizeTool())
    ) {
      return;
    }

    // Vector tools route through the editor service instead of the raster pen.
    if (this.editorService.isVectorTool()) {
      if (event.button === 0) {
        this.vectorEditor.onPointerDown(
          this.zoomPanService.getImageCoordinatesRaw(event),
          { shift: event.shiftKey, toggle: event.ctrlKey || event.metaKey },
        );
      }
      return;
    }

    // Vectorize: a left-click traces the clicked component's outer contour.
    if (this.editorService.isVectorizeTool()) {
      if (event.button === 0) {
        void this.convertService.vectorizeAt(
          this.zoomPanService.getImageCoordinatesRaw(event),
        );
      }
      return;
    }

    // Skeletonize: a left-click traces the clicked component's centerline.
    if (this.editorService.isSkeletonizeTool()) {
      if (event.button === 0) {
        void this.convertService.skeletonizeAt(
          this.zoomPanService.getImageCoordinatesRaw(event),
        );
      }
      return;
    }

    // The raster pen is the one branch with no button check of its own — every
    // vector branch above already guards on `button === 0`.
    if (event.button !== 0) return;
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

    try {
      this.zoomPanService.endDrag();
      if (this.editorService.canPan()) return;

      if (this.editorService.isVectorTool()) {
        if (this.usesVectorTool()) this.vectorEditor.onPointerUp();
        return;
      }

      await this.drawService.endDraw(event);
    } finally {
      // After the stroke is committed, so it ends with the tool it began with.
      if (this.toolSwapped) {
        this.toolSwapped = false;
        this.editorService.restoreLastTool();
      }
    }
  }

  // ── Pinch (zoom + pan) ───────────────────────────────────────────────────

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
    // The gesture that borrowed a tool is over, without reaching `pointerUp`.
    if (this.toolSwapped) {
      this.toolSwapped = false;
      this.editorService.restoreLastTool();
    }
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

  // ── Helpers ──────────────────────────────────────────────────────────────

  private isTouchEvent(event: MouseEvent | TouchEvent): event is TouchEvent {
    // Not `instanceof`: the canvas may be in another window, whose events are
    // built from that window's own classes.
    return 'touches' in event;
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
