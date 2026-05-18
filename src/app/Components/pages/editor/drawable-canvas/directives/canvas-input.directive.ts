import { Directive, EventEmitter, HostListener, Output } from '@angular/core';
import { ZoomPanService } from '../service/zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { DrawService } from '../service/draw.service';
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

  constructor(
    private zoomPanService: ZoomPanService,
    private editorService: EditorService,
    private drawService: DrawService,
  ) {}

  @HostListener('mousedown', ['$event'])
  @HostListener('touchstart', ['$event'])
  onMouseDown(event: MouseEvent | TouchEvent) {
    const mouseEvent = this.normalizeEvent(event);
    if (!mouseEvent) return;

    if (mouseEvent.button === 1) {
      this.editorService.activatePanMode();
    }

    if (this.editorService.canPan()) {
      this.zoomPanService.startDrag(mouseEvent);
    } else {
      this.drawService.startDraw(mouseEvent);
    }
  }

  @HostListener('mousemove', ['$event'])
  @HostListener('touchmove', ['$event'])
  onMouseMove(event: MouseEvent | TouchEvent) {
    if (this.isTouchEvent(event)) {
      event.preventDefault();
    }
    const mouseEvent = this.normalizeEvent(event);
    if (!mouseEvent) return;

    const coords = this.zoomPanService.getImageCoordinates(mouseEvent);
    const cursor = this.zoomPanService.getViewportCoordinates(mouseEvent);
    this.canvasMove.emit({ event: mouseEvent, coords, cursor });
  }

  @HostListener('mouseup', ['$event'])
  @HostListener('touchend', ['$event'])
  async onMouseUp(event: MouseEvent | TouchEvent) {
    const mouseEvent = this.normalizeEvent(event);
    if (!mouseEvent) return;

    if (mouseEvent.button === 1) {
      this.editorService.restoreLastTool();
    }

    this.zoomPanService.endDrag();
    if (!this.editorService.canPan()) {
      await this.drawService.endDraw(mouseEvent);
    }
  }

  @HostListener('mouseleave', ['$event'])
  async onMouseLeave(event: MouseEvent | TouchEvent) {
    await this.onMouseUp(event);
  }

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
    Object.defineProperty(synthetic, 'currentTarget', { value: event.currentTarget });
    return synthetic;
  }
}