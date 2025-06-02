import { Injectable } from '@angular/core';
import { LabelFormat } from '../../Core/interface';
import { ProjectService } from './project.service';
import { path } from '@tauri-apps/api';
import { invoke } from '@tauri-apps/api/core';
import { LabelsService } from './labels.service';
import { ViewService } from '../UI/view.service';
import { ImageFromCLI } from '../../Core/interface';
import { Subject } from 'rxjs';
import { CanvasManagerService } from '../../Components/pages/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../../Components/pages/editor/drawable-canvas/service/state-manager.service';
import {
  blobToDataURL,
  invokeSaveCSVFile,
  invokeSaveXmlFile,
  invokeLoadCsvFile,
} from '../../Core/save_load';
import { ClassificationService } from './classification.service';

@Injectable({
  providedIn: 'root',
})
export class IOService {
  public requestedReload: Subject<boolean> = new Subject<boolean>();

  constructor(
    private projectService: ProjectService,
    private labelService: LabelsService,
    private viewService: ViewService,
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private classificationService: ClassificationService
  ) {
    this.classificationService.requestReload.subscribe(() => {
      this.loadClassification();
    });
  }

  requestReload() {
    this.requestedReload.next(true);
  }

  checkIfDataExists(filepath: string): Promise<boolean> {
    return invoke<boolean>('check_file_exists', { filepath })
      .then((response) => {
        return response ? true : false;
      })
      .catch((error) => {
        return false;
      });
  }

  async loadExistingAnnotations(): Promise<LabelFormat> {
    const filepath = await this.getMaskSavePath();
    const response = await invoke<string>('load_xml_file', { filepath });

    // Parse the XML file and load the annotations
    const parser = new DOMParser();
    const doc = parser.parseFromString(response as string, 'image/svg+xml');

    let labels = {
      masksName: [],
      masks: [],
      colors: [],
      multiclass: null,
      multilabel: null,
      shades: null,
      texts: [],
      textsNames: [],
    } as LabelFormat;

    // Get the image elements and their data
    const imageElements = doc.getElementsByTagName('image');
    for (let i = 0; i < imageElements.length; i++) {
      const imageElement = imageElements[i];
      const href = imageElement.getAttribute('href') as string;
      const color = imageElement.getAttribute('color');
      const id = imageElement.getAttribute('id');

      if (imageElement.hasAttribute('shades')) {
        if (!labels.shades) {
          labels.shades = [];
        }
        labels.shades.push(imageElement.getAttribute('shades')!.split(','));
      }

      labels.masksName.push(id!);
      labels.colors.push(color!);
      labels.masks.push(href);
    }

    const textElements = doc.getElementsByTagName('text');
    if (textElements.length > 0) {
      labels.textsNames = textElements[0].getAttribute('names')!.split(',');
    }
    return labels;
  }

  async load() {
    let exists = await this.checkIfDataExists(await this.getMaskSavePath());
    if (!exists) {
      return;
    }
    let data = await this.loadExistingAnnotations();

    data.masksName.forEach((label, index) => {
      let segLabel = {
        label: label,
        color: data.colors[index],
        isVisible: true,
        shades: data.shades ? data.shades[index] : null,
      };
      this.labelService.addSegLabel(segLabel);
    });
    this.labelService.rebuildTreeNodes();
    this.labelService.activeLabel = this.labelService.listSegmentationLabels[0];

    this.canvasManagerService.initCanvas();
    await this.canvasManagerService.loadAllCanvas(data.masks as string[]);

    this.loadClassification();
  }

  async loadClassification() {
    let exists = await this.checkIfDataExists(await this.getGlobalSavePath());
    if (!exists) {
      return;
    }
    const csv = await invokeLoadCsvFile(await this.getGlobalSavePath());
    this.classificationService.loadCSV(csv);
  }

  async save() {
    // this.viewService.setLoading(true, 'Saving annotations');
    let savefile = {
      masksName: [],
      masks: [],
      colors: [],
      shades: null,
      multiclass: [],
      multilabel: null,
      textsNames: [],
      texts: [],
    } as LabelFormat;

    let allPromises$: Promise<void>[] = [];
    for (let i = 0; i < this.labelService.listSegmentationLabels.length; i++) {
      const label = this.labelService.listSegmentationLabels[i];
      if (label.shades) {
        if (!savefile.shades) {
          savefile.shades = [];
        }
        savefile.shades.push(label.shades);
      }
      savefile.masksName.push(label.label);
      let canvas = this.canvasManagerService.labelCanvas[i];
      savefile.colors.push(label.color);
      await canvas
        .convertToBlob({ type: 'image/png' })
        .then((blob) => {
          return blobToDataURL(blob);
        })
        .then((blob) => {
          savefile.masks.push(blob);
        });
    }

    this.labelService.listTextLabels.forEach((label) => {
      savefile.textsNames.push(label.name);
      savefile.texts!.push(label.text);
    });

    let finished = Promise.all(allPromises$)
      .then(() => {
        this.writeSave(
          savefile,
          this.stateService.width,
          this.stateService.height
        );
      })
      .then(() => {
        return true;
      });
    return finished;
  }

  saveFromCLI(data: ImageFromCLI, imageName: string | null = null) {
    let savefile = {
      masksName: [],
      masks: [],
      colors: [],
      shades: null,
      textsNames: [],
      texts: [],
    } as LabelFormat;

    this.labelService.listSegmentationLabels.forEach((label, index) => {
      if (label.shades) {
        if (!savefile.shades) {
          savefile.shades = [];
        }
        savefile.shades.push(label.shades);
      }

      savefile.masksName.push(label.label);
      if (data.mask_data) {
        savefile.masks.push(data.mask_data[index]);
      }
      savefile.colors.push(label.color);
    });
    // TODO: Add multiclass and multilabel support

    if (data.texts) {
      savefile.texts = data.texts;
    }

    this.labelService.listTextLabels.forEach((label) => {
      savefile.textsNames.push(label.name);
    });
    return this.writeSave(savefile, data.width, data.height, imageName);
  }

  async writeSave(
    labelFormat: LabelFormat,
    width: number,
    height: number,
    imageName: string | null = null
  ) {
    if (this.projectService.isSegmentation) {
      let svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      svg.setAttribute('height', `${height}`);
      svg.setAttribute('width', `${width}`);

      const nElements = labelFormat.masks.length;
      for (let i = 0; i < nElements; i++) {
        var svgMask = document.createElementNS(
          'http://www.w3.org/2000/svg',
          'image'
        );

        let maskValue = labelFormat.masks[i] as string; // This is the blob, we need to convert it to a string to be able to use it in the href attribute
        svgMask.setAttribute('x', '0');
        svgMask.setAttribute('y', '0');
        svgMask.setAttribute('width', `${width}`);
        svgMask.setAttribute('height', `${height}`);
        svgMask.setAttribute('href', maskValue);
        svgMask.setAttribute('id', labelFormat.masksName[i]);
        svgMask.setAttribute('color', labelFormat.colors[i]);
        if (labelFormat.shades) {
          svgMask.setAttribute('shades', labelFormat.shades[i].join(','));
        }
        svg.appendChild(svgMask);
      }
      const maskSavePath = await this.getMaskSavePath(imageName);

      await invokeSaveXmlFile(
        maskSavePath,
        new XMLSerializer().serializeToString(svg)
      );
    }

    await this.saveClassification();
  }

  async saveClassification() {
    const classificationSavePath = await this.getGlobalSavePath();
    let classificationData = this.classificationService.generateCSV();
    await invokeSaveCSVFile(classificationSavePath, classificationData);
  }

  async getMaskSavePath(imageName: string | null = null) {
    if (!imageName) {
      imageName =
        this.projectService.imagesName[this.projectService.activeIndex!];
    }
    const imageNameWithoutExtension = imageName
      .split('.')
      .slice(0, -1)
      .join('.');
    const svgName = imageNameWithoutExtension + '.svg';
    return path.join(
      this.projectService.projectFolder,
      'annotations',
      'local',
      svgName
    );
  }

  async getGlobalSavePath() {
    const csvName = 'classification.csv';
    return path.join(this.projectService.projectFolder, 'annotations', csvName);
  }
}
