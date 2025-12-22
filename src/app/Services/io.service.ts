import { Injectable, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { path } from '@tauri-apps/api';
import { invoke } from '@tauri-apps/api/core';

// Services
import { ProjectService } from './ProjectService/project.service';
import { LabelsService } from './Labels/labels.service';
import { CanvasManagerService } from '../Components/pages/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../Components/pages/editor/drawable-canvas/service/state-manager.service';
import { ClassificationService } from './Labels/classification.service';
import { MultiframesService } from './multiframes.service';

// Core
import { LabelFormat } from '../Core/interface';
import { ImageFromCLI } from './TauriEvent/interface';
import {
  blobToDataURL,
  invokeSaveCSVFile,
  invokeSaveXmlFile,
  invokeLoadCsvFile,
} from '../Core/save_load';

@Injectable({
  providedIn: 'root',
})
export class IOService implements OnDestroy {
  public requestedReload = new Subject<boolean>();

  private destroy$ = new Subject<void>();

  constructor(
    private projectService: ProjectService,
    private labelService: LabelsService,
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private classificationService: ClassificationService,
    private multiframesService: MultiframesService
  ) {
    this.initializeSubscriptions();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private initializeSubscriptions(): void {
    this.classificationService.requestReload
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        this.loadClassification();
      });
  }

  // ==========================================
  // Public API
  // ==========================================

  public requestReload(): void {
    this.requestedReload.next(true);
  }

  /**
   * Load annotations for the current active image.
   * Loads segmentation masks and classification data.
   */
  public async load(): Promise<void> {
    const maskPath = await this.getMaskSavePath();
    const exists = await this.checkIfDataExists(maskPath);

    if (!exists) {
      return;
    }

    try {
      const data = await this.loadExistingAnnotations();
      this.applyLoadedAnnotations(data);
      await this.loadClassification();
    } catch (error) {
      console.error('Failed to load annotations:', error);
      throw error;
    }
  }

  /**
   * Save annotations for the current active image.
   */
  public async save(): Promise<boolean> {
    try {
      const savefile = await this.buildSaveFormat();

      if (this.shouldSaveToMultipleFrames()) {
        await this.saveToMultipleFrames(savefile);
      } else {
        await this.writeSave(
          savefile,
          this.stateService.width,
          this.stateService.height
        );
      }

      return true;
    } catch (error) {
      console.error('Failed to save annotations:', error);
      return false;
    }
  }

  /**
   * Save annotations from CLI data (used for automated processing).
   */
  public async saveFromCLI(
    data: ImageFromCLI,
    imageName: string | null = null
  ): Promise<void> {
    const savefile = this.buildSaveFormatFromCLI(data);
    await this.writeSave(savefile, data.width, data.height, imageName);
  }

  // ==========================================
  // File Operations
  // ==========================================

  public async checkIfDataExists(filepath: string): Promise<boolean> {
    try {
      return await invoke<boolean>('check_file_exists', { filepath });
    } catch (error) {
      console.warn('Error checking file existence:', filepath, error);
      return false;
    }
  }

  public async loadClassification(): Promise<void> {
    const classificationPath = await this.getGlobalSavePath();
    const exists = await this.checkIfDataExists(classificationPath);

    if (!exists) {
      return;
    }

    try {
      const csv = await invokeLoadCsvFile(classificationPath);
      this.classificationService.loadCSV(csv);
    } catch (error) {
      console.error('Failed to load classification:', error);
    }
  }

  public async saveClassification(): Promise<void> {
    const classificationSavePath = await this.getGlobalSavePath();
    const classificationData = this.classificationService.generateCSV();
    await invokeSaveCSVFile(classificationSavePath, classificationData);
  }

  // ==========================================
  // Path Generation
  // ==========================================

  public async getMaskSavePath(
    imageName: string | null = null
  ): Promise<string> {
    const name = imageName ?? this.getCurrentImageName();
    const svgName = this.replaceExtension(name, '.svg');

    return path.join(
      this.projectService.projectFolder,
      'annotations',
      'local',
      svgName
    );
  }

  public async getGlobalSavePath(): Promise<string> {
    return path.join(
      this.projectService.projectFolder,
      'annotations',
      'classification.csv'
    );
  }

  // ==========================================
  // Private Helpers - Loading
  // ==========================================

  private async loadExistingAnnotations(): Promise<LabelFormat> {
    const filepath = await this.getMaskSavePath();
    const response = await invoke<string>('load_xml_file', { filepath });

    return this.parseAnnotationXML(response);
  }

  private parseAnnotationXML(xmlString: string): LabelFormat {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlString, 'image/svg+xml');

    const labels: LabelFormat = {
      masksName: [],
      masks: [],
      colors: [],
      shades: null,
      texts: [],
      textsNames: [],
    };

    // Parse image elements (masks)
    const imageElements = doc.getElementsByTagName('image');
    for (let i = 0; i < imageElements.length; i++) {
      const element = imageElements[i];

      labels.masksName.push(element.getAttribute('id')!);
      labels.colors.push(element.getAttribute('color')!);
      labels.masks.push(element.getAttribute('href')!);

      // Parse shades if present
      if (element.hasAttribute('shades')) {
        if (!labels.shades) {
          labels.shades = [];
        }
        labels.shades.push(element.getAttribute('shades')!.split(','));
      }
    }

    // Parse text elements
    const textElements = doc.getElementsByTagName('text');
    if (textElements.length > 0) {
      const namesAttr = textElements[0].getAttribute('names');
      if (namesAttr) {
        labels.textsNames = namesAttr.split(',');
      }
    }

    return labels;
  }

  private applyLoadedAnnotations(data: LabelFormat): void {
    // Add segmentation labels
    data.masksName.forEach((label, index) => {
      const segLabel = {
        label: label,
        color: data.colors[index],
        isVisible: true,
        shades: data.shades ? data.shades[index] : null,
      };
      this.labelService.addSegLabel(segLabel);
    });

    this.labelService.rebuildTreeNodes();
    this.labelService.activeLabel = this.labelService.listSegmentationLabels[0];

    // Initialize and load canvases
    this.canvasManagerService.initCanvas();
    this.canvasManagerService.loadAllCanvas(data.masks as string[]);
  }

  // ==========================================
  // Private Helpers - Saving
  // ==========================================

  private async buildSaveFormat(): Promise<LabelFormat> {
    const savefile: LabelFormat = {
      masksName: [],
      masks: [],
      colors: [],
      shades: null,
      textsNames: [],
      texts: [],
    };

    // Build segmentation data
    for (let i = 0; i < this.labelService.listSegmentationLabels.length; i++) {
      const label = this.labelService.listSegmentationLabels[i];

      if (label.shades) {
        if (!savefile.shades) {
          savefile.shades = [];
        }
        savefile.shades.push(label.shades);
      }

      savefile.masksName.push(label.label);
      savefile.colors.push(label.color);

      // Convert canvas to data URL
      const canvas = this.canvasManagerService.labelCanvas[i];
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const dataUrl = await blobToDataURL(blob);
      savefile.masks.push(dataUrl);
    }

    // Build text label data
    this.labelService.listTextLabels.forEach((label) => {
      savefile.textsNames.push(label.name);
      savefile.texts!.push(label.text);
    });

    return savefile;
  }

  private buildSaveFormatFromCLI(data: ImageFromCLI): LabelFormat {
    const savefile: LabelFormat = {
      masksName: [],
      masks: [],
      colors: [],
      shades: null,
      textsNames: [],
      texts: [],
    };

    this.labelService.listSegmentationLabels.forEach((label, index) => {
      if (label.shades) {
        if (!savefile.shades) {
          savefile.shades = [];
        }
        savefile.shades.push(label.shades);
      }

      savefile.masksName.push(label.label);
      savefile.colors.push(label.color);

      if (data.mask_data) {
        savefile.masks.push(data.mask_data[index]);
      }
    });

    if (data.texts) {
      savefile.texts = data.texts;
    }

    this.labelService.listTextLabels.forEach((label) => {
      savefile.textsNames.push(label.name);
    });

    return savefile;
  }

  private shouldSaveToMultipleFrames(): boolean {
    return !!(
      this.projectService.groupLabels && this.multiframesService.activeGroup
    );
  }

  private async saveToMultipleFrames(savefile: LabelFormat): Promise<void> {
    const currentGroup = this.multiframesService.groupedFrames.get(
      this.multiframesService.activeGroup!
    );

    if (!currentGroup) {
      return;
    }

    const frameNames = this.projectService.extractImagesName(currentGroup);
    const savePromises = frameNames.map((frameName) =>
      this.writeSave(
        savefile,
        this.stateService.width,
        this.stateService.height,
        frameName
      )
    );

    await Promise.all(savePromises);
  }

  public async writeSave(
    labelFormat: LabelFormat,
    width: number,
    height: number,
    imageName: string | null = null
  ): Promise<void> {
    if (this.projectService.isSegmentation) {
      const svgContent = this.buildSVGContent(labelFormat, width, height);
      const maskSavePath = await this.getMaskSavePath(imageName);
      await invokeSaveXmlFile(maskSavePath, svgContent);
    }

    await this.saveClassification();
  }

  private buildSVGContent(
    labelFormat: LabelFormat,
    width: number,
    height: number
  ): string {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    svg.setAttribute('height', `${height}`);
    svg.setAttribute('width', `${width}`);

    for (let i = 0; i < labelFormat.masks.length; i++) {
      const svgMask = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'image'
      );

      svgMask.setAttribute('x', '0');
      svgMask.setAttribute('y', '0');
      svgMask.setAttribute('width', `${width}`);
      svgMask.setAttribute('height', `${height}`);
      svgMask.setAttribute('href', labelFormat.masks[i] as string);
      svgMask.setAttribute('id', labelFormat.masksName[i]);
      svgMask.setAttribute('color', labelFormat.colors[i]);

      if (labelFormat.shades) {
        svgMask.setAttribute('shades', labelFormat.shades[i].join(','));
      }

      svg.appendChild(svgMask);
    }

    return new XMLSerializer().serializeToString(svg);
  }

  // ==========================================
  // Utility Methods
  // ==========================================

  private getCurrentImageName(): string {
    return this.projectService.imagesName[this.projectService.activeIndex!];
  }

  private replaceExtension(filename: string, newExtension: string): string {
    const nameWithoutExtension = filename.split('.').slice(0, -1).join('.');
    return nameWithoutExtension + newExtension;
  }
  // io.service.ts (additions)

  /**
   * Load an image from CLI command.
   * Handles path resolution, validation, and persistence.
   */
  async loadImageFromCLI(imageConfig: ImageFromCLI): Promise<void> {
    // Resolve absolute path
    const absolutePath = await path.resolve(imageConfig.image_path);

    // Calculate relative path from project input folder
    const relativePath = this.getRelativePathFromInputFolder(absolutePath);

    // Register image in project
    this.projectService.registerImage(relativePath);

    // Persist image data
    await this.saveFromCLI(imageConfig, relativePath);
  }

  /**
   * Extract relative path from absolute image path.
   * Validates that image is within the project's input folder.
   */
  private getRelativePathFromInputFolder(absolutePath: string): string {
    const inputFolder = this.projectService.inputFolder;

    if (!absolutePath.startsWith(inputFolder)) {
      throw new Error(
        `Image path ${absolutePath} is outside input folder ${inputFolder}`
      );
    }

    // Remove input folder prefix to get relative path
    return absolutePath.substring(inputFolder.length);
  }
}
