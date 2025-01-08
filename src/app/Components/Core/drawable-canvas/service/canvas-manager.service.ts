import { Injectable } from '@angular/core';
import { StateManagerService } from './state-manager.service';
import { LabelsService } from '../../../../Services/Project/labels.service';
import { OpenCVService } from '../../../../Services/open-cv.service';
import { EditorService } from '../../../../Services/UI/editor.service';
import { Subject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class CanvasManagerService {

  labelCanvas: OffscreenCanvas[] = [];
  canvasCtx: OffscreenCanvasRenderingContext2D[] = [];

  combinedCanvas: OffscreenCanvas;
  combinedCtx: OffscreenCanvasRenderingContext2D;

  bufferCanvas: OffscreenCanvas;
  bufferCtx: OffscreenCanvasRenderingContext2D;

  requestRedraw: Subject<boolean> = new Subject<boolean>();


  constructor(private stateService: StateManagerService, 
    private labelService: LabelsService,
    private openCVService: OpenCVService,
    private editorService: EditorService) { }


  initCanvas(){
    this.labelCanvas = [];
    this.canvasCtx = [];
    this.labelService.listSegmentationLabels.forEach((label) => {
      const canvas = new OffscreenCanvas(this.stateService.width, this.stateService.height);
      this.labelCanvas.push(canvas);
      this.canvasCtx.push(canvas.getContext('2d', {alpha: true})!);
    });
    this.combinedCanvas = new OffscreenCanvas(this.stateService.width, this.stateService.height);
    this.combinedCtx = this.combinedCanvas.getContext('2d', {alpha: true})!;
    this.bufferCanvas = new OffscreenCanvas(this.stateService.width, this.stateService.height);
    this.bufferCtx = this.bufferCanvas.getContext('2d', {alpha: true})!;

    this.bufferCtx.filter = 'url(#remove-alpha)';
  }

  computeCombinedCanvas(){
    this.combinedCtx.clearRect(0, 0, this.stateService.width, this.stateService.height);
    this.labelCanvas.forEach((canvas, index) => {
      if(!this.labelService.listSegmentationLabels[index].isVisible){
        return;
      }
      // if(this.editorService.edgesOnly){
      //   canvas = this.openCVService.edgeDetection(this.canvasCtx[index]) as OffscreenCanvas;
      // }
      this.combinedCtx.drawImage(canvas, 0, 0);
    });
    if(this.editorService.edgesOnly){
      let edge = this.openCVService.edgeDetection(this.combinedCtx);
      this.combinedCtx.clearRect(0, 0, this.stateService.width, this.stateService.height);
      this.combinedCtx.drawImage(edge, 0, 0);

    }
  }

  clearCanvasAtIndex(index: number){
    this.clearCanvas(this.canvasCtx[index]);
  }

  loadCanvas(data: string, index:number):Promise<boolean>{
    const img = new Image();
    img.src = data;
    return new Promise((resolve, reject) => {
      img.onload = () => {
        this.clearCanvas(this.canvasCtx[index]);
        this.canvasCtx[index].drawImage(img, 0, 0);
        resolve(true);
      };
    });
    
  }

  clearCanvas(ctx: OffscreenCanvasRenderingContext2D){
    ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
  }

  resetCombinedCanvas(){
    this.clearCanvas(this.combinedCtx);
  }

  async loadAllCanvas(data: string[]){
    for(let i = 0; i < data.length; i++){
      await this.loadCanvas(data[i], i);
    }
  }

  getBufferCanvas(){
    return this.bufferCanvas;
  }

  getActiveCanvas(){
    let activeIndex = this.labelService.getActiveIndex();
    return this.labelCanvas[activeIndex];
  }

  getActiveCtx(){
    let activeIndex = this.labelService.getActiveIndex();
    return this.canvasCtx[activeIndex];
  }

  getBufferCtx(){
    return this.bufferCtx;
  }

  getCombinedCtx(){
    return this.combinedCtx;
  }

  getCombinedCanvas(){
    return this.combinedCanvas;
  }

  getActiveIndex(){
    return this.labelService.getActiveIndex();
  }
  getAllCanvasCtx(){
    return this.canvasCtx;
  }

  getAllCanvas(){
    return this.labelCanvas;
  }






}
