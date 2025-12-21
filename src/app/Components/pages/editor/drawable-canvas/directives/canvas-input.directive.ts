import { Directive, EventEmitter, HostListener, Output } from '@angular/core';
import { ZoomPanService } from '../service/zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { Point2D } from '../interface';
import { DrawService } from '../service/draw.service';

@Directive({
  selector: '[appCanvasInput]',
  standalone: true
})
export class CanvasInputDirective {
  @Output() canvasMove = new EventEmitter<{event: MouseEvent, coords: Point2D, cursor: Point2D}>();
  @Output() canvasUp = new EventEmitter<MouseEvent>();

  constructor(
    private zoomPanService: ZoomPanService,
    private editorService: EditorService,
    private drawService: DrawService
  ) {}

  @HostListener('mousedown', ['$event'])
  @HostListener('touchstart', ['$event'])
  onMouseDown(event: MouseEvent | TouchEvent) {

    const mouseEvent = this.normalizeEvent(event);
    
    // Middle click or space+click logic
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
    if (event instanceof TouchEvent) event.preventDefault();
    const mouseEvent = this.normalizeEvent(event);
    
    const target = mouseEvent.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    
    const coords = this.zoomPanService.getImageCoordinates(mouseEvent);
    const cursor = {
      x: mouseEvent.clientX - rect.left,
      y: mouseEvent.clientY - rect.top
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
    this.onMouseUp(event);
  }

  private normalizeEvent(event: MouseEvent | TouchEvent): MouseEvent {
    if (event instanceof MouseEvent) return event;
    const touch = event.touches[0] || event.changedTouches[0];
    return new MouseEvent('normalized', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
    });
  }
}