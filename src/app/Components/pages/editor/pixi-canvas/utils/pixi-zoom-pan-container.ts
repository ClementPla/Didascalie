import { Container, Point } from 'pixi.js';

/**
 * Zoom and pan controller for PixiJS container
 * Uses native PixiJS transformations without custom animations
 */
export class PixiZoomPanController {
  private container: Container;
  private minScale = 0.1;
  private maxScale = 30;
  private prevPoint: { x: number; y: number } | null = null;
  private isDragging = false;

  constructor(container: Container) {
    this.container = container;
  }

  /**
   * Handle mouse wheel zoom
   */
  public wheel(event: WheelEvent): void {
    event.preventDefault();

    // Zoom intensity (how much to zoom per scroll)
    const zoomIntensity = 0.1;
    const direction = event.deltaY < 0 ? 1 : -1;
    const zoom = 1 + direction * zoomIntensity;

    // Calculate new scale
    const oldScale = this.container.scale.x;
    let newScale = oldScale * zoom;

    // Clamp scale
    newScale = Math.max(this.minScale, Math.min(this.maxScale, newScale));

    // Get mouse position relative to the canvas
    const rect = (event.target as HTMLElement).getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    // Calculate world position before zoom
    const worldPos = this.container.toLocal(new Point(mouseX, mouseY));

    // Apply new scale
    this.container.scale.set(newScale);

    // Calculate world position after zoom
    const newScreenPos = this.container.toGlobal(worldPos);

    // Adjust position to keep mouse point stable
    this.container.position.x += mouseX - newScreenPos.x;
    this.container.position.y += mouseY - newScreenPos.y;
  }

  /**
   * Start dragging/panning
   */
  public startDrag(event: MouseEvent): void {
    this.prevPoint = { x: event.clientX, y: event.clientY };
    this.isDragging = true;
  }

  /**
   * Continue dragging/panning
   */
  public drag(event: MouseEvent): void {
    if (!this.isDragging || !this.prevPoint) return;

    const dx = event.clientX - this.prevPoint.x;
    const dy = event.clientY - this.prevPoint.y;

    this.container.position.x += dx;
    this.container.position.y += dy;

    this.prevPoint = { x: event.clientX, y: event.clientY };
  }

  /**
   * End dragging/panning
   */
  public endDrag(): void {
    this.isDragging = false;
    this.prevPoint = null;
  }

  /**
   * Zoom in by a factor
   */
  public zoomIn(factor: number = 1.2): void {
    const oldScale = this.container.scale.x;
    let newScale = oldScale * factor;
    newScale = Math.min(this.maxScale, newScale);

    // Zoom to center
    this.zoomToCenter(newScale);
  }

  /**
   * Zoom out by a factor
   */
  public zoomOut(factor: number = 1.2): void {
    const oldScale = this.container.scale.x;
    let newScale = oldScale / factor;
    newScale = Math.max(this.minScale, newScale);

    // Zoom to center
    this.zoomToCenter(newScale);
  }

  /**
   * Zoom to a specific scale, centered on viewport
   */
  private zoomToCenter(newScale: number): void {
    if (!this.container.parent) return;
    const oldScale = this.container.scale.x;

    // Get center point of viewport (assuming it's the canvas center)
    const centerX = this.container.parent.width / 2;
    const centerY = this.container.parent.height / 2;

    // Calculate world position at center
    const worldPos = this.container.toLocal(new Point(centerX, centerY));

    // Apply new scale
    this.container.scale.set(newScale);

    // Calculate new screen position
    const newScreenPos = this.container.toGlobal(worldPos);

    // Adjust position to keep center stable
    this.container.position.x += centerX - newScreenPos.x;
    this.container.position.y += centerY - newScreenPos.y;
  }

  /**
   * Reset zoom and pan to initial state
   */
  public reset(): void {
    this.container.scale.set(1);
    this.container.position.set(0, 0);
  }

  /**
   * Fit content to viewport
   */
  public fitToScreen(
    contentWidth: number,
    contentHeight: number,
    viewportWidth: number,
    viewportHeight: number
  ): void {
    const scaleX = viewportWidth / contentWidth;
    const scaleY = viewportHeight / contentHeight;
    const scale = Math.min(scaleX, scaleY);

    // Clamp to min/max
    const finalScale = Math.max(this.minScale, Math.min(this.maxScale, scale));

    this.container.scale.set(finalScale);

    // Center the content
    const scaledWidth = contentWidth * finalScale;
    const scaledHeight = contentHeight * finalScale;

    this.container.position.x = (viewportWidth - scaledWidth) / 2;
    this.container.position.y = (viewportHeight - scaledHeight) / 2;
  }

  /**
   * Get current zoom level
   */
  public getZoom(): number {
    return this.container.scale.x;
  }

  /**
   * Set zoom level
   */
  public setZoom(scale: number): void {
    const clampedScale = Math.max(
      this.minScale,
      Math.min(this.maxScale, scale)
    );
    this.container.scale.set(clampedScale);
  }

  /**
   * Get current pan position
   */
  public getPan(): { x: number; y: number } {
    return {
      x: this.container.position.x,
      y: this.container.position.y,
    };
  }

  /**
   * Set pan position
   */
  public setPan(x: number, y: number): void {
    this.container.position.set(x, y);
  }

  /**
   * Set min/max scale limits
   */
  public setScaleLimits(min: number, max: number): void {
    this.minScale = min;
    this.maxScale = max;
  }

  /**
   * Check if currently dragging
   */
  public getIsDragging(): boolean {
    return this.isDragging;
  }
}
