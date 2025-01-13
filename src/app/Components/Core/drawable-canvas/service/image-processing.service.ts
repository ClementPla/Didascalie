import { Injectable } from '@angular/core';
import { EditorService } from '../../../../Services/UI/editor.service';
import { OpenCVService } from '../../../../Services/open-cv.service';
import { PostProcessService } from './post-process.service';

@Injectable({
  providedIn: 'root'
})
export class ImageProcessingService {

  ref_image: HTMLImageElement;
  private ref_canvas: HTMLCanvasElement | null = null; 
  // We don't use OffscreenCanvas because it's not supported by OpenCV.js
  preprocessImage: HTMLCanvasElement | null = null;

  to_BW: boolean = false;
  use_medianBlur: boolean = false;
  contrast: number = 1;
  brightness: number = 0;

  gamma: number = 1;

  stretchHist: boolean = false;

  kernel_size: number = 3;
  isUpdated: boolean = false;
  edgeStrength: number = 1;
  reinforceEdges: boolean = false;

  constructor(private editorService: EditorService, 
    private openCVService: OpenCVService) { }


  refresh() {
    this.preprocess()
    this.editorService.requestCanvasRedraw();
  }

  getCurrentCanvas(): HTMLCanvasElement {

    if (!this.editorService.useProcessing) {
      return this.ref_canvas!;
    }

    if (!this.isUpdated || this.preprocessImage === null) {
      this.preprocess();
      this.editorService.requestCanvasRedraw();
    }

    return this.preprocessImage!;

  }

  setImage(img: HTMLImageElement) {
    this.ref_image = img;
    this.isUpdated = false;
    this.ref_canvas = document.createElement('canvas');
    this.ref_canvas.width = img.width;
    this.ref_canvas.height = img.height;
    let ctx = this.ref_canvas.getContext('2d', { alpha: false })!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
    

  }

  checkValidInput(){
    // Cast to float
    this.contrast = this.contrast
    this.brightness = this.brightness
    this.gamma = this.gamma
    this.edgeStrength = this.edgeStrength
    

  }
  preprocess() {
    if (this.ref_canvas === null) {
      return;
    }
    try {
      this.checkValidInput();
    }
    catch (e) {
      console.error(e);
      return;
    }

    if (this.preprocessImage === null) {
      this.preprocessImage = document.createElement('canvas');
      this.preprocessImage.width = this.ref_image.width;
      this.preprocessImage.height = this.ref_image.height;

    }
    this.preprocessImage.getContext('2d', { alpha: false, willReadFrequently: false })!.drawImage(this.ref_canvas, 0, 0);

    if(this.stretchHist) {

      this.openCVService.stretchHist(this.preprocessImage, this.preprocessImage);
    }


    if(this.contrast !== 1 || this.brightness !== 0) {
      this.openCVService.brightness_contrast(this.preprocessImage, this.preprocessImage, this.contrast, this.brightness);
    }

    if(this.gamma !== 1) {
      this.openCVService.gammaCorrection(this.preprocessImage, this.preprocessImage, this.gamma);
    }

   

    // Convert to gryscale
    if (this.to_BW) {
      this.openCVService.to_grayscale(this.preprocessImage, this.preprocessImage);
    }

    if(this.use_medianBlur) {
      this.openCVService.median_blur(this.preprocessImage, this.preprocessImage, this.kernel_size);
    }

    if(this.reinforceEdges && this.edgeStrength > 0) {
      this.openCVService.reinforceEdges(this.preprocessImage, this.preprocessImage, this.edgeStrength);
    }

    
    this.isUpdated = true;

  }

  
}
