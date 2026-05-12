import { Directive, EventEmitter, HostListener, Output } from '@angular/core';
import { ZoomPanService } from '../service/zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { Point2D } from '../interface';
import { DrawService } from '../service/draw.service';

@Directive({
  selector: '[appCanvasInput]',
  standalone: true,
})
export class CanvasInputDirective {
  @Output() canvasMove = new EventEmitter<{
    event: MouseEvent;
    coords: Point2D;
    cursor: Point2D;
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
    const target = mouseEvent.target as HTMLElement;
    const rect = target.getBoundingClientRect();

    const coords = this.zoomPanService.getImageCoordinates(mouseEvent);
    const cursor = {
      x: mouseEvent.clientX - rect.left,
      y: mouseEvent.clientY - rect.top,
    };

    this.canvasMove.emit({ event: mouseEvent, coords, cursor });
  }

  @HostListener('mouseup', ['$event'])
  @HostListener('touchend', ['$event'])
  async onMouseUp(event: MouseEvent | TouchEvent) {
    const mouseEvent = this.normalizeEvent(event);

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

  /**
   * Check if TouchEvent exists and event is an instance of it.
   */
  private isTouchEvent(event: MouseEvent | TouchEvent): event is TouchEvent {
    return typeof TouchEvent !== 'undefined' && event instanceof TouchEvent;
  }

  private normalizeEvent(event: MouseEvent | TouchEvent): MouseEvent {
    if (!this.isTouchEvent(event)) return event;

    const touch = event.changedTouches[0] || event.touches[0];
    if (!touch) return null as any; // or change return type to MouseEvent | null

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
