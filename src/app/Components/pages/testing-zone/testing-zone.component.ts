import { AfterViewInit, Component, ElementRef, OnInit, ViewChild } from '@angular/core';
import { OpenCVService } from '../../../Services/open-cv.service';

@Component({
  selector: 'app-testing-zone',
  standalone: true,
  imports: [],
  templateUrl: './testing-zone.component.html',
  styleUrl: './testing-zone.component.scss'
})
export class TestingZoneComponent implements AfterViewInit {

  @ViewChild('testCanvas') canvas: ElementRef<HTMLCanvasElement> | undefined;
  @ViewChild('testCanvas2') canvas2: ElementRef<HTMLCanvasElement> | undefined;

  width: number = 512;
  height: number = 512;

  ctx: CanvasRenderingContext2D;
  ctx2: CanvasRenderingContext2D;

  constructor(private opencvService: OpenCVService) {}
  ngAfterViewInit(): void {
    if (!this.canvas) {
      console.error('Canvas element not found!');
      return;
    }
    if (!this.canvas2) {
      console.error('Canvas element not found!');
      return;
    }
    this.ctx = this.canvas.nativeElement.getContext('2d') as CanvasRenderingContext2D;
    this.ctx2 = this.canvas2.nativeElement.getContext('2d') as CanvasRenderingContext2D;
    this.init_canvases(this.ctx);
    this.init_canvases(this.ctx2);
    // Wait for a second
    this.testDraw();
    this.ctx2.imageSmoothingEnabled = false;
    // Set the anchor point to the center of the canvas
    this.ctx2.translate(-this.width, -this.height);
    
    this.ctx2.scale(4.0, 4.0);
    this.ctx2.drawImage(this.canvas.nativeElement, 0, 0, this.width, this.height);
    
  }

  init_canvases(ctx: CanvasRenderingContext2D) {
    ctx.canvas.width = this.width;
    ctx.canvas.height = this.height;
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, this.width, this.height);
    
    
  }

  testDraw() {

    // Simple Line, from (0,0) to (100,100)
    // Change cap style to round
    this.ctx.imageSmoothingEnabled = false;

    this.ctx.beginPath();
    this.ctx.translate(0, 0);
    this.ctx.moveTo(250, 250);
    this.ctx.lineTo(750, 500);
    this.ctx.strokeStyle = 'pink';
    this.ctx.lineWidth = 150;
    this.ctx.lineCap = 'round'; // round, square, butt
    this.ctx.stroke();
    this.ctx.closePath();
  }
}
