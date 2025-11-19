import { RenderTexture, Sprite, Graphics, Renderer } from 'pixi.js';

/**
 * Represents a single drawing layer with its own texture and rendering
 */
export class DrawingLayer {
  public readonly id: string;
  public readonly texture: RenderTexture;
  public readonly sprite: Sprite;
  public color: number;
  public visible: boolean = true;

  private graphics: Graphics;

  constructor(id: string, width: number, height: number, color: number) {
    this.id = id;
    this.color = color;

    // Create texture with no antialiasing
    this.texture = RenderTexture.create({
      width,
      height,
      scaleMode: 'nearest',
      antialias: false,
      format: 'rgba8unorm',
      resolution: 1,
    });

    this.sprite = new Sprite(this.texture);
    this.sprite.roundPixels = true;

    this.graphics = new Graphics();
  }

  /**
   * Draw a stroke segment on this layer
   */
  public drawStroke(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    lineWidth: number,
    renderer: Renderer
  ): void {
    this.graphics.clear();

    this.graphics.setStrokeStyle({
      width: lineWidth,
      color: this.color,
      alpha: 1,
      cap: 'round',
      join: 'round',
    });

    this.graphics.moveTo(fromX, fromY);
    this.graphics.lineTo(toX, toY);
    this.graphics.stroke();

    renderer.render({
      container: this.graphics,
      target: this.texture,
      clear: false,
    });
  }

  /**
   * Draw a filled polygon (for lasso tool)
   */
  public drawPolygon(
    points: { x: number; y: number }[],
    renderer: Renderer
  ): void {
    if (points.length < 3) return;

    this.graphics.clear();
    this.graphics.poly(points);
    this.graphics.fill({ color: this.color });

    renderer.render({
      container: this.graphics,
      target: this.texture,
      clear: false,
    });
  }

  /**
   * Draw a single dot (for mouse down)
   */
  public drawDot(
    x: number,
    y: number,
    radius: number,
    renderer: Renderer
  ): void {
    this.graphics.clear();
    this.graphics.circle(x, y, radius);
    this.graphics.fill({ color: this.color });

    renderer.render({
      container: this.graphics,
      target: this.texture,
      clear: false,
    });
  }

  /**
   * Erase a stroke segment using blend mode
   */

  public eraseStroke(
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
    lineWidth: number,
    renderer: Renderer
  ): void {
    // Extract current texture to canvas
    const canvas = renderer.extract.canvas(this.sprite);
    const ctx = canvas.getContext('2d')!;
    // Remove antialiasing
    ctx.imageSmoothingEnabled = false;
    // Use destination-out to erase pixels
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = `#${this.color.toString(16).padStart(6, '0')}`; // Color doesn't matter, only alpha
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // Restore composite operation
    ctx.globalCompositeOperation = 'source-over';

    // Render modified canvas back to texture
    const tempSprite = Sprite.from(canvas);
    renderer.render({
      container: tempSprite,
      target: this.texture,
      clear: true,
    });

    tempSprite.destroy();
  }

  /**
   * Erase a polygon area using canvas composite operation
   */
  public erasePolygon(
    points: { x: number; y: number }[],
    renderer: Renderer
  ): void {
    if (points.length < 3) return;

    // Extract current texture to canvas
    const canvas = renderer.extract.canvas(this.sprite);
    const ctx = canvas.getContext('2d')!;

    // Use destination-out to erase pixels
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(255,255,255,1)';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();
    ctx.fill();

    // Restore composite operation
    ctx.globalCompositeOperation = 'source-over';

    // Render modified canvas back to texture
    const tempSprite = Sprite.from(canvas);
    renderer.render({
      container: tempSprite,
      target: this.texture,
      clear: true,
    });

    tempSprite.destroy();
  }

  /**
   * Erase a single dot using canvas composite operation
   */
  public eraseDot(
    x: number,
    y: number,
    radius: number,
    renderer: Renderer
  ): void {
    // Extract current texture to canvas
    const canvas = renderer.extract.canvas(this.sprite);
    const ctx = canvas.getContext('2d')!;

    // Use destination-out to erase pixels
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = 'rgba(255,255,255,1)';

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Restore composite operation
    ctx.globalCompositeOperation = 'source-over';

    // Render modified canvas back to texture
    const tempSprite = Sprite.from(canvas);
    renderer.render({
      container: tempSprite,
      target: this.texture,
      clear: true,
    });

    tempSprite.destroy();
  }

  /**
   * Binarize the layer (remove antialiasing)
   */
  public binarize(renderer: Renderer, threshold: number = 127): void {
    const canvas = renderer.extract.canvas(this.sprite);
    const ctx = canvas.getContext('2d')!;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Binarize alpha channel
    for (let i = 3; i < data.length; i += 4) {
      data[i] = data[i] > threshold ? 255 : 0;
    }

    ctx.putImageData(imageData, 0, 0);

    // Render back to texture
    const tempSprite = Sprite.from(canvas);
    renderer.render({
      container: tempSprite,
      target: this.texture,
      clear: true,
    });

    tempSprite.destroy();
  }

  /**
   * Change the color of this layer
   */
  public changeColor(newColor: number, renderer: Renderer): void {
    this.color = newColor;

    const canvas = renderer.extract.canvas(this.sprite);
    const ctx = canvas.getContext('2d')!;

    // Use source-atop to recolor
    ctx.fillStyle = `#${newColor.toString(16).padStart(6, '0')}`;
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'source-over';

    // Render back
    const tempSprite = Sprite.from(canvas);
    renderer.render({
      container: tempSprite,
      target: this.texture,
      clear: true,
    });

    tempSprite.destroy();
  }

  /**
   * Clear the entire layer
   */
  public clear(renderer: Renderer): void {
    renderer.render({
      container: new Graphics(),
      target: this.texture,
      clear: true,
    });
  }

  /**
   * Get layer state for undo/redo
   */
  public getState(renderer: Renderer): ImageData {
    const canvas = renderer.extract.canvas(this.sprite);
    const ctx = canvas.getContext('2d')!;
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  /**
   * Restore layer state from undo/redo
   */
  public setState(imageData: ImageData, renderer: Renderer): void {
    const canvas = document.createElement('canvas');
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(imageData, 0, 0);

    const tempSprite = Sprite.from(canvas);
    renderer.render({
      container: tempSprite,
      target: this.texture,
      clear: true,
    });

    tempSprite.destroy();
  }

  /**
   * Toggle visibility
   */
  public setVisible(visible: boolean): void {
    this.visible = visible;
    this.sprite.visible = visible;
  }

  /**
   * Cleanup
   */
  public destroy(): void {
    this.graphics.destroy();
    this.texture.destroy(true);
    this.sprite.destroy();
  }
}
