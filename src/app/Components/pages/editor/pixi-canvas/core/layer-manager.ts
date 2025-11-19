import { Container, Renderer } from 'pixi.js';
import { DrawingLayer } from './drawing-layer';

/**
 * Manages all drawing layers
 */
export class LayerManager {
  private layers: Map<string, DrawingLayer> = new Map();
  private layerOrder: string[] = [];
  private activeLayerId: string | null = null;

  constructor(
    private container: Container,
    private renderer: Renderer,
    private width: number,
    private height: number
  ) {}

  /**
   * Create a new layer
   */
  public createLayer(id: string, color: number): DrawingLayer {
    if (this.layers.has(id)) {
      throw new Error(`Layer ${id} already exists`);
    }

    const layer = new DrawingLayer(id, this.width, this.height, color);
    this.layers.set(id, layer);
    this.layerOrder.push(id);

    // Add sprite to container
    this.container.addChild(layer.sprite);

    // Set as active if it's the first layer
    if (this.layers.size === 1) {
      this.activeLayerId = id;
    }

    return layer;
  }

  /**
   * Get a layer by ID
   */
  public getLayer(id: string): DrawingLayer | undefined {
    return this.layers.get(id);
  }

  /**
   * Get the active layer
   */
  public getActiveLayer(): DrawingLayer | null {
    if (!this.activeLayerId) return null;
    return this.layers.get(this.activeLayerId) || null;
  }

  /**
   * Set active layer
   */
  public setActiveLayer(id: string): void {
    if (!this.layers.has(id)) {
      throw new Error(`Layer ${id} does not exist`);
    }
    this.activeLayerId = id;
  }

  /**
   * Get all layers
   */
  public getAllLayers(): DrawingLayer[] {
    return this.layerOrder.map((id) => this.layers.get(id)!);
  }

  /**
   * Delete a layer
   */
  public deleteLayer(id: string): void {
    const layer = this.layers.get(id);
    if (!layer) return;

    this.container.removeChild(layer.sprite);
    layer.destroy();
    this.layers.delete(id);

    const index = this.layerOrder.indexOf(id);
    if (index > -1) {
      this.layerOrder.splice(index, 1);
    }

    // Update active layer if needed
    if (this.activeLayerId === id) {
      this.activeLayerId =
        this.layerOrder.length > 0 ? this.layerOrder[0] : null;
    }
  }

  /**
   * Clear a specific layer
   */
  public clearLayer(id: string): void {
    const layer = this.layers.get(id);
    if (layer) {
      layer.clear(this.renderer);
    }
  }

  /**
   * Clear all layers
   */
  public clearAllLayers(): void {
    this.layers.forEach((layer) => layer.clear(this.renderer));
  }

  /**
   * Change layer order (z-index)
   */
  public reorderLayer(id: string, newIndex: number): void {
    const oldIndex = this.layerOrder.indexOf(id);
    if (oldIndex === -1) return;

    this.layerOrder.splice(oldIndex, 1);
    this.layerOrder.splice(newIndex, 0, id);

    // Update container children order
    this.updateContainerOrder();
  }

  /**
   * Update container children to match layer order
   */
  private updateContainerOrder(): void {
    this.layerOrder.forEach((id, index) => {
      const layer = this.layers.get(id);
      if (layer) {
        this.container.setChildIndex(layer.sprite, index);
      }
    });
  }

  /**
   * Toggle layer visibility
   */
  public setLayerVisible(id: string, visible: boolean): void {
    const layer = this.layers.get(id);
    if (layer) {
      layer.setVisible(visible);
    }
  }

  /**
   * Get combined state of all layers for undo/redo
   */
  public getAllLayerStates(): Map<string, ImageData> {
    const states = new Map<string, ImageData>();
    this.layers.forEach((layer, id) => {
      states.set(id, layer.getState(this.renderer));
    });
    return states;
  }

  /**
   * Restore all layer states from undo/redo
   */
  public setAllLayerStates(states: Map<string, ImageData>): void {
    states.forEach((imageData, id) => {
      const layer = this.layers.get(id);
      if (layer) {
        layer.setState(imageData, this.renderer);
      }
    });
  }

  /**
   * Cleanup all layers
   */
  public destroy(): void {
    this.layers.forEach((layer) => layer.destroy());
    this.layers.clear();
    this.layerOrder = [];
    this.activeLayerId = null;
  }
}
