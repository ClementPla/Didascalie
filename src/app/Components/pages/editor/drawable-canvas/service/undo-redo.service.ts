import { Injectable } from '@angular/core';
import { UndoRedo } from '../../../../../Core/misc/undoRedo';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { EditorService } from '../../../../../Services/UI/editor.service';
import { LabelsService } from '../../../../../Services/Project/labels.service';
import { BehaviorSubject } from 'rxjs';
@Injectable({
  providedIn: 'root',
})
export class UndoRedoService {

  public redrawRequest: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  constructor(
    private canvasManagerService: CanvasManagerService,
    private stateService: StateManagerService,
    private editorService: EditorService,
    private labelService: LabelsService
  ) {
    this.editorService.undo.subscribe((value) => {
      if (value) {
        this.stateService.recomputeCanvasSum = true;
        this.undo();
      }
    });
    this.editorService.redo.subscribe((value) => {
      if (value) {
        this.stateService.recomputeCanvasSum = true;
        this.redo();
      }
    });
  }

  undo() {
    const element = UndoRedo.undo();
    if (element) {
      this.canvasManagerService.getAllCanvasCtx().forEach(async (ctx, index) => {
        let data: Blob;
        if (Array.isArray(element.data)) {
          data = element.data[index];
        } else if (element.index != index) {
          return;
        } else {
          data = element.data as Blob;
        }
        const imageBitmap = createImageBitmap(data);
        await imageBitmap.then((img) => {
          ctx?.clearRect(0, 0, this.stateService.width, this.stateService.height);
          ctx?.drawImage(img, 0, 0, this.stateService.width, this.stateService.height);
          if (ctx) {
            this.redrawRequest.next(true);
          }
        });
      });
    }
  }
  redo() {
    const element = UndoRedo.redo();
    if (element) {
      this.canvasManagerService.getAllCanvasCtx().forEach((ctx, index) => {
        let data: Blob;
        if (Array.isArray(element.data)) {
          data = element.data[index];
        } else if (element.index != index) {
          return;
        } else {
          data = element.data as Blob;
        }

        const imageBitmap = createImageBitmap(data);
        imageBitmap.then((img) => {
          ctx?.clearRect(
            0,
            0,
            this.stateService.width,
            this.stateService.height
          );
          ctx?.drawImage(
            img,
            0,
            0,
            this.stateService.width,
            this.stateService.height
          );

          if (ctx) {
            this.redrawRequest.next(true);
          }
        });
      });
    }
  }

  empty() {
    UndoRedo.empty();
  }

  public update_undo_redo(): Promise<void> {
    if (this.editorService.affectsMultipleLabels()) {
      let allPromises: Promise<Blob>[] = [];
      this.canvasManagerService.getAllCanvas().forEach((classCanvas) => {
        const blob$ = classCanvas.convertToBlob({ type: 'image/png' });
        allPromises.push(blob$);
      });
      return Promise.all(allPromises).then((blobs) => {
        UndoRedo.push({ data: blobs, index: -1 });
      });
    } else {
      const blob$ = this.canvasManagerService.getActiveCanvas().convertToBlob({ type: 'image/png' });
      return blob$.then((blob) => {
        UndoRedo.push({
          data: blob,
          index: this.labelService.getActiveIndex(),
        });
      });
    }
  }
}
