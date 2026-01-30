import { Directive, EventEmitter, Output, ElementRef, OnInit, OnDestroy, NgZone } from '@angular/core';
import { ZoomPanService } from '../service/zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { Point2D } from '../interface';
import { DrawService } from '../service/draw.service';

@Directive({
  selector: '[appCanvasInput]',
  standalone: true
})
export class CanvasInputDirective implements OnInit, OnDestroy {
  @Output() canvasMove = new EventEmitter<{event: MouseEvent, coords: Point2D, cursor: Point2D}>();
  @Output() canvasUp = new EventEmitter<MouseEvent>();

  private element: HTMLElement;

  constructor(
    private elementRef: ElementRef,
    private zoomPanService: ZoomPanService,
    private editorService: EditorService,
    private drawService: DrawService,
    private ngZone: NgZone
  ) {
    this.element = this.elementRef.nativeElement;
  }

  ngOnInit() {
    // Run outside Angular zone for better performance
    this.ngZone.runOutsideAngular(() => {
      // Mouse events
      this.element.addEventListener('mousedown', this.onMouseDown.bind(this));
      this.element.addEventListener('mousemove', this.onMouseMove.bind(this));
      this.element.addEventListener('mouseup', this.onMouseUp.bind(this));
      this.element.addEventListener('mouseleave', this.onMouseLeave.bind(this));
      
      // Touch events with passive: false for Safari
      this.element.addEventListener('touchstart', this.onMouseDown.bind(this), { passive: false });
      this.element.addEventListener('touchmove', this.onMouseMove.bind(this), { passive: false });
      this.element.addEventListener('touchend', this.onMouseUp.bind(this), { passive: false });
    });
  }

  ngOnDestroy() {
    this.element.removeEventListener('mousedown', this.onMouseDown.bind(this));
    this.element.removeEventListener('mousemove', this.onMouseMove.bind(this));
    this.element.removeEventListener('mouseup', this.onMouseUp.bind(this));
    this.element.removeEventListener('mouseleave', this.onMouseLeave.bind(this));
    this.element.removeEventListener('touchstart', this.onMouseDown.bind(this));
    this.element.removeEventListener('touchmove', this.onMouseMove.bind(this));
    this.element.removeEventListener('touchend', this.onMouseUp.bind(this));
  }

  private onMouseDown = (event: MouseEvent | TouchEvent) => {
    const mouseEvent = this.normalizeEvent(event);
    
    if (mouseEvent.button === 1) {
      this.editorService.activatePanMode();
    }
    
    if (this.editorService.canPan()) {
      this.zoomPanService.startDrag(mouseEvent);
    } else {
      this.drawService.startDraw(mouseEvent);
    }
  };

  private onMouseMove = (event: MouseEvent | TouchEvent) => {
    if (event instanceof TouchEvent) {
      event.preventDefault();
    }
    
    const mouseEvent = this.normalizeEvent(event);
    const target = this.element;
    const rect = target.getBoundingClientRect();
    
    const coords = this.zoomPanService.getImageCoordinates(mouseEvent);
    const cursor = {
      x: mouseEvent.clientX - rect.left,
      y: mouseEvent.clientY - rect.top
    };
    
    // Run inside Angular zone for change detection
    this.ngZone.run(() => {
      this.canvasMove.emit({ event: mouseEvent, coords, cursor });
    });
  };

  private onMouseUp = async (event: MouseEvent | TouchEvent) => {
    const mouseEvent = this.normalizeEvent(event);
    
    if (mouseEvent.button === 1) {
      this.editorService.restoreLastTool();
    }
    
    this.zoomPanService.endDrag();
    
    if (!this.editorService.canPan()) {
      await this.drawService.endDraw(mouseEvent);
    }
  };

  private onMouseLeave = async (event: MouseEvent | TouchEvent) => {
    await this.onMouseUp(event);
  };

  private normalizeEvent(event: MouseEvent | TouchEvent): MouseEvent {
    if (event instanceof MouseEvent) return event;
    
    const touch = event.touches[0] || event.changedTouches[0];
    
    if (!touch) {
      console.warn('No touch point found');
      return new MouseEvent('normalized', {
        clientX: 0,
        clientY: 0,
        button: 0,
      });
    }
    
    return new MouseEvent('normalized', {
      clientX: touch.clientX,
      clientY: touch.clientY,
      button: 0,
    });
  }
}