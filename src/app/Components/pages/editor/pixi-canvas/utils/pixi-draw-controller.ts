import { Application, Graphics, RenderTexture, Sprite } from 'pixi.js';
import * as PIXI from 'pixi.js';

export class PixiDrawController {
  private app: Application;
  private bufferTexture: RenderTexture;
  private activeTexture: RenderTexture;
  private previousPoint: { x: number; y: number } | null = null;
  private currentPoint: { x: number; y: number } | null = null;
  private isDrawing = false;
  private lineWidth = 5;
  private fillColor = 0xff0000; // Example color

  constructor(
    app: Application,
    bufferTexture: RenderTexture,
    activeTexture: RenderTexture
  ) {
    this.app = app;
    this.bufferTexture = bufferTexture;
    this.activeTexture = activeTexture;
  }

  public startDraw(point: { x: number; y: number }) {
    this.isDrawing = true;
    this.previousPoint = point;
    this.currentPoint = point;
  }

  public draw(point: { x: number; y: number }) {
    if (!this.isDrawing) return;
    this.currentPoint = point;
    this.drawPen();
    this.previousPoint = point;
  }

  private drawPen() {
    const g = new Graphics();
    g.setStrokeStyle({
      width: this.lineWidth,
      color: this.fillColor,
      alpha: 1,
    });
    g.moveTo(this.previousPoint!.x, this.previousPoint!.y);
    g.lineTo(this.currentPoint!.x, this.currentPoint!.y);

    this.app.renderer.render(g, {
      renderTexture: this.bufferTexture,
    });
    g.destroy();
  }

  public endDraw() {
    if (!this.isDrawing) return;
    const bufferSprite = new Sprite(this.bufferTexture);
    this.app.renderer.render(bufferSprite, {
      renderTexture: this.activeTexture,
    });
    bufferSprite.destroy();
    this.isDrawing = false;
    this.previousPoint = null;
    this.currentPoint = null;
  }
}
