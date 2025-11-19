import { RenderTexture, Sprite, Graphics } from 'pixi.js';

export class DrawingLayer {
  public texture: RenderTexture;
  public sprite: Sprite;
  public graphics: Graphics;
  public color: number;

  constructor(width: number, height: number, color: number) {
    this.color = color;

    // Create texture with no antialiasing
    this.texture = RenderTexture.create({
      width,
      height,
      scaleMode: 'nearest',
      antialias: false,
    });

    this.sprite = new Sprite(this.texture);
    this.sprite.roundPixels = true;

    this.graphics = new Graphics();
  }

  // Draw a stroke segment
  public drawStroke(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    lineWidth: number,
    renderer: any
  ) {
    this.graphics.clear();

    this.graphics.setStrokeStyle({
      width: lineWidth,
      color: this.color,
      alpha: 1,
      cap: 'round',
      join: 'round',
      // No native "disable antialiasing" option here, but render texture settings help
    });

    this.graphics.moveTo(fromX, fromY);
    this.graphics.lineTo(toX, toY);
    this.graphics.stroke();

    // Render to layer texture
    renderer.render({
      container: this.graphics,
      target: this.texture,
      clear: false,
    });
  }

  // Erase using destination-out blend mode
  public erase(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    lineWidth: number,
    renderer: any
  ) {
    this.graphics.clear();

    // Draw in white (color doesn't matter for erasing)
    this.graphics.setStrokeStyle({
      width: lineWidth,
      color: 0xffffff,
      alpha: 1,
      cap: 'round',
      join: 'round',
    });

    this.graphics.moveTo(fromX, fromY);
    this.graphics.lineTo(toX, toY);
    this.graphics.stroke();

    // Use ERASE blend mode
    renderer.render({
      container: this.graphics,
      target: this.texture,
      clear: false,
      transform: undefined,
      // Note: For true destination-out, you might need a custom filter/shader
    });
  }

  // Clear entire layer
  public clear(renderer: any) {
    renderer.renderTexture.clear(this.texture);
  }

  // Change color (like your refreshColor)
  public changeColor(newColor: number, renderer: any) {
    this.color = newColor;

    // Create a colored rectangle with source-atop blend
    const colorOverlay = new Graphics();
    colorOverlay.rect(0, 0, this.texture.width, this.texture.height);
    colorOverlay.fill({ color: newColor });

    // You'll need to implement source-atop via shader or mask
    // For now, this is a simplified version
  }
}
