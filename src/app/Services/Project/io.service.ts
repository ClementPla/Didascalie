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
import { blobToDataURL, invokeSaveXmlFile } from '../../Core/save_load';

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
    private stateService: StateManagerService
  ) {}

  requestReload() {
    this.requestedReload.next(true);
  }

  checkIfDataExists(): Promise<boolean> {
    return this.getActiveSavePath().then((filepath) => {
      return invoke<boolean>('check_file_exists', { filepath })
        .then((response) => {
          return response ? true : false;
        })
        .catch((error) => {
          return false;
        });
    });
  }

  async loadExistingAnnotations(): Promise<LabelFormat> {
    const filepath = await this.getActiveSavePath();
    const response = await invoke<string>('load_xml_file', { filepath });

    // Parse the XML file and load the annotations
    const parser = new DOMParser();
    const doc = parser.parseFromString(response as string, 'image/svg+xml');

    let labels = {
      masksName: [],
      masks: [],
      labels: [],
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

    // Get the multiclass elements
    const multiclassElements = doc.getElementsByTagName('multiclass');
    if (multiclassElements.length > 0) {
      let attributes = multiclassElements[0].getAttribute('classes');
      if (attributes) {
        labels.multiclass = attributes.split(',');
      }
    }

    // Get the multilabel elements
    const multilabelElements = doc.getElementsByTagName('multilabel');
    if (multilabelElements.length > 0) {
      let attributes = multilabelElements[0].getAttribute('classes');
      if (attributes) {
        labels.multilabel = attributes.split(',');
      }
    }

    const textElements = doc.getElementsByTagName('text');
    if (textElements.length > 0) {
      labels.textsNames = textElements[0].getAttribute('names')!.split(',');
    }
    return labels;
  }

  async load() {
    let exists = await this.checkIfDataExists();
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
    if (this.labelService.multiLabelTask) {
      if (data.multilabel) {
        console.log('Setting multilabel choices');
        console.log(data.multilabel);
        this.labelService.multiLabelTask.choices = data.multilabel;
      } else {
        this.labelService.multiLabelTask.choices = [];
      }
    }
    if (this.labelService.listTextLabels.length > 0) {
      if (
        data.texts &&
        data.texts.length === this.labelService.listTextLabels.length
      ) {
        data.texts.forEach((text, index) => {
          this.labelService.listTextLabels[index].text = text;
        });
      }
    }
    if (this.labelService.listClassificationTasks.length > 0) {
      if (
        data.multiclass &&
        data.multiclass.length ===
          this.labelService.listClassificationTasks.length
      ) {
        data.multiclass.forEach((choice, index) => {
          this.labelService.listClassificationTasks[index].choice = choice;
        });
      } else if (!data.multiclass) {
        this.labelService.listClassificationTasks.forEach((task) => {
          task.choice = '';
        });
      }
    }

    this.labelService.activeLabel = this.labelService.listSegmentationLabels[0];

    this.canvasManagerService.initCanvas();
    await this.canvasManagerService.loadAllCanvas(data.masks as string[]);
  }

  async save() {
    this.viewService.setLoading(true, 'Saving annotations');
    let savefile = {
      masksName: [],
      masks: [],
      labels: [],
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
      savefile.labels.push(label.label);
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
    if (this.labelService.multiLabelTask) {
      savefile.multilabel = this.labelService.multiLabelTask.choices;
    }
    this.labelService.listClassificationTasks.forEach((task) => {
      if (task.choice) {
        savefile.multiclass?.push(task.choice);
      }
    });

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
        this.viewService.endLoading();
        return true;
      });
    return finished;
  }

  saveFromCLI(data: ImageFromCLI, imageName: string | null = null) {
    let savefile = {
      masksName: [],
      masks: [],
      labels: [],
      colors: [],
      multiclass: null,
      multilabel: null,
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

      savefile.labels.push(label.label);
      savefile.masksName.push(label.label);
      if (data.mask_data) {
        savefile.masks.push(data.mask_data[index]);
      }
      savefile.colors.push(label.color);
    });

    if (data.classification_classes) {
      savefile.multiclass = data.classification_classes;
    }

    if (data.classification_multilabel) {
      savefile.multilabel = data.classification_multilabel;
    }
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
    if (labelFormat.multiclass) {
      let multiclass = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'multiclass'
      );
      multiclass.setAttribute('classes', labelFormat.multiclass.join(','));
      svg.appendChild(multiclass);
    }
    if (labelFormat.multilabel) {
      let multilabel = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'multilabel'
      );
      multilabel.setAttribute('classes', labelFormat.multilabel.join(','));
      svg.appendChild(multilabel);
    }
    return invokeSaveXmlFile(
      await this.getActiveSavePath(imageName),
      new XMLSerializer().serializeToString(svg)
    );
  }

  async getActiveSavePath(imageName: string | null = null) {
    if (!imageName) {
      imageName =
        this.projectService.imagesName[this.projectService.activeIndex!];
    }
    const imageNameWithoutExtension = imageName
      .split('.')
      .slice(0, -1)
      .join('.');
    const svgName = imageNameWithoutExtension + '.svg';
    return path.join(this.projectService.projectFolder, 'annotations', svgName);
  }
}
