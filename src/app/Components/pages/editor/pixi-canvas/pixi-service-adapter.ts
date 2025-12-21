import { Subscription } from 'rxjs';
import { DrawingController } from './core/drawing-controller';
import { LayerManager } from './core/layer-manager';
import { EditorService } from '../services/editor.service';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { ProjectService } from '../../../../Services/ProjectService/project.service';
import { Tools } from '../../../../Core/tools';
import { ToolRegistry } from './tools/tools.interface';
import { SegLabel } from '../../../../Core/interface';

/**
 * Adapter that bridges Angular services with PixiJS controllers
 * Handles bidirectional communication between the old service-based
 * architecture and the new class-based PixiJS system
 */
export class PixiServiceAdapter {
  private subscriptions = new Subscription();

  constructor(
    private drawingController: DrawingController,
    private layerManager: LayerManager,
    private editorService: EditorService,
    private labelsService: LabelsService,
    private projectService: ProjectService
  ) {
    this.setupServiceListeners();
    this.syncInitialState();
  }

  /**
   * Setup listeners for service events
   */
  private setupServiceListeners(): void {
    // Undo/Redo
    this.subscriptions.add(
      this.editorService.undo.subscribe(() => {
        this.drawingController.undo();
      })
    );

    this.subscriptions.add(
      this.editorService.redo.subscribe(() => {
        this.drawingController.redo();
      })
    );

    // Canvas clear
    this.subscriptions.add(
      this.editorService.canvasClear.subscribe((index: number) => {
        if (index >= 0) {
          // Clear specific layer
          const layerId = this.getLayerIdForLabel(index);
          this.layerManager.clearLayer(layerId);
        } else {
          // Clear all layers
          this.layerManager.clearAllLayers();
        }
      })
    );

    // Canvas redraw (for layer visibility changes, etc.)
    this.subscriptions.add(
      this.editorService.canvasRedraw.subscribe(() => {
        this.syncLayerVisibility();
        this.syncLayerColors();
      })
    );
  }

  /**
   * Sync initial state from services to PixiJS
   */
  private syncInitialState(): void {
    // Sync line width
    this.drawingController.options.lineWidth = this.editorService.lineWidth;

    // Sync binarization (opposite of antialiasing)
    this.drawingController.options.binarizeAfterStroke = true;

    // Sync tool
    this.syncTool();

    // Sync layers from labels
    this.syncLayersFromLabels();
  }

  /**
   * Sync current tool from EditorService
   */
  public syncTool(): void {
    const tool = this.editorService.selectedTool;

    if (tool.id === Tools.PAN.id) {
      // Pan is handled by zoom/pan controller, not drawing controller
      return;
    }

    const pixiTool = ToolRegistry.getTool(tool);
    if (pixiTool) {
      this.drawingController.setTool(pixiTool);
    }
  }

  /**
   * Sync line width from EditorService
   */
  public syncLineWidth(): void {
    this.drawingController.options.lineWidth = this.editorService.lineWidth;
  }

  /**
   * Create layers based on LabelsService
   * Handles both regular segmentation and instance segmentation
   */
  public syncLayersFromLabels(): void {
    // Clear existing layers
    const existingLayers = this.layerManager.getAllLayers();
    existingLayers.forEach((layer) => {
      this.layerManager.deleteLayer(layer.id);
    });

    if (this.projectService.isInstanceSegmentation) {
      // Instance segmentation: Create layers based on shades
      this.createInstanceSegmentationLayers();
    } else {
      // Regular segmentation: One layer per label
      this.createRegularSegmentationLayers();
    }

    // Set active layer based on active label
    this.syncActiveLayer();
  }

  /**
   * Create layers for regular segmentation (one per label)
   */
  private createRegularSegmentationLayers(): void {
    this.labelsService.listSegmentationLabels.forEach((label, index) => {
      const color = this.hexToNumber(label.color);
      const layerId = this.getLayerIdForLabel(index);
      this.layerManager.createLayer(layerId, color);
    });
  }

  /**
   * Create layers for instance segmentation (multiple instances per label)
   */
  private createInstanceSegmentationLayers(): void {
    this.labelsService.listSegmentationLabels.forEach((label, labelIndex) => {
      if (label.shades && label.shades.length > 0) {
        // Create a layer for each shade (instance)
        label.shades.forEach((shade, instanceIndex) => {
          const color = this.hexToNumber(shade);
          const layerId = this.getLayerIdForInstance(labelIndex, instanceIndex);
          this.layerManager.createLayer(layerId, color);
        });
      } else {
        // Fallback: create single layer with label color
        const color = this.hexToNumber(label.color);
        const layerId = this.getLayerIdForLabel(labelIndex);
        this.layerManager.createLayer(layerId, color);
      }
    });
  }

  /**
   * Sync active layer when active label or instance changes
   */
  public syncActiveLayer(): void {
    if (
      this.projectService.isInstanceSegmentation &&
      this.labelsService.activeSegInstance
    ) {
      // Instance segmentation: set active layer based on instance
      const labelIndex = this.labelsService.getActiveIndex();
      const instanceIndex = this.labelsService.activeSegInstance.instance;
      const layerId = this.getLayerIdForInstance(labelIndex, instanceIndex);

      try {
        this.layerManager.setActiveLayer(layerId);
      } catch (e) {
        console.warn(`Could not set active layer: ${layerId}`);
      }
    } else {
      // Regular segmentation
      const activeIndex = this.labelsService.getActiveIndex();
      if (activeIndex >= 0) {
        const layerId = this.getLayerIdForLabel(activeIndex);
        try {
          this.layerManager.setActiveLayer(layerId);
        } catch (e) {
          console.warn(`Could not set active layer: ${layerId}`);
        }
      }
    }
  }

  /**
   * Sync layer visibility based on label visibility
   */
  public syncLayerVisibility(): void {
    this.labelsService.listSegmentationLabels.forEach((label, index) => {
      if (this.projectService.isInstanceSegmentation && label.shades) {
        // Update visibility for all instance layers
        label.shades.forEach((_, instanceIndex) => {
          const layerId = this.getLayerIdForInstance(index, instanceIndex);
          const layer = this.layerManager.getLayer(layerId);
          if (layer) {
            this.layerManager.setLayerVisible(layerId, label.isVisible);
          }
        });
      } else {
        // Update visibility for regular layer
        const layerId = this.getLayerIdForLabel(index);
        const layer = this.layerManager.getLayer(layerId);
        if (layer) {
          this.layerManager.setLayerVisible(layerId, label.isVisible);
        }
      }
    });
  }

  /**
   * Sync layer colors when they change
   */
  public syncLayerColors(): void {
    this.labelsService.listSegmentationLabels.forEach((label, index) => {
      const layerId = this.getLayerIdForLabel(index);
      const layer = this.layerManager.getLayer(layerId);
      if (layer) {
        const newColor = this.hexToNumber(label.color);
        if (layer.color !== newColor) {
          layer.color = newColor;
        }
      }
    });
  }

  /**
   * Update EditorService state from PixiJS (reverse sync)
   */
  public updateServiceState(): void {
    // Update undo/redo availability if needed
    const canUndo = this.drawingController.canUndo();
    const canRedo = this.drawingController.canRedo();

    // Could emit events or update service properties here if needed
  }

  /**
   * Helper: Get layer ID for a label index (regular segmentation)
   */
  private getLayerIdForLabel(index: number): string {
    return `label_${index}`;
  }

  /**
   * Helper: Get layer ID for an instance (instance segmentation)
   */
  private getLayerIdForInstance(
    labelIndex: number,
    instanceIndex: number
  ): string {
    return `label_${labelIndex}_inst_${instanceIndex}`;
  }

  /**
   * Helper: Parse layer ID back to indices
   */
  public parseLayerId(layerId: string): {
    labelIndex: number;
    instanceIndex?: number;
  } {
    const parts = layerId.split('_');
    const labelIndex = parseInt(parts[1]);

    if (parts.length > 3) {
      // Instance layer: label_X_inst_Y
      const instanceIndex = parseInt(parts[3]);
      return { labelIndex, instanceIndex };
    }

    // Regular layer: label_X
    return { labelIndex };
  }

  /**
   * Get all layers for a specific label (useful for operations like "erase all")
   */
  public getLayersForLabel(labelIndex: number): string[] {
    const label = this.labelsService.listSegmentationLabels[labelIndex];
    const layerIds: string[] = [];

    if (this.projectService.isInstanceSegmentation && label.shades) {
      label.shades.forEach((_, instanceIndex) => {
        layerIds.push(this.getLayerIdForInstance(labelIndex, instanceIndex));
      });
    } else {
      layerIds.push(this.getLayerIdForLabel(labelIndex));
    }

    return layerIds;
  }

  /**
   * Helper: Convert hex color to number
   */
  private hexToNumber(hex: string): number {
    const cleanHex = hex.replace('#', '');
    return parseInt(cleanHex, 16);
  }

  /**
   * Helper: Convert number to hex color
   */
  public numberToHex(color: number): string {
    return `#${color.toString(16).padStart(6, '0')}`;
  }

  /**
   * Cleanup subscriptions
   */
  public destroy(): void {
    this.subscriptions.unsubscribe();
  }
}
