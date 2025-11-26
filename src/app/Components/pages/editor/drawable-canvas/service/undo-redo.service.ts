import { Injectable } from '@angular/core';
import { UndoRedo } from '../../../../../Core/misc/undoRedo';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { EditorService } from '../../../../../Services/UI/editor.service';
import { LabelsService } from '../../../../../Services/Project/labels.service';
import { BehaviorSubject } from 'rxjs';
import { UndoRedoCanvasElement } from '../../../../../Core/interface';

@Injectable({
  providedIn: 'root',
})
export class UndoRedoService {
  public redrawRequest: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(
    false
  );

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

  async undo() {
    const element = UndoRedo.undo();
    if (!element) {
      return;
    }

    try {
      await this.restoreCanvasState(element);
    } catch (error) {
      console.error('Error during undo:', error);
    }
  }

  async redo() {
    const element = UndoRedo.redo();
    if (!element) {
      return;
    }

    try {
      await this.restoreCanvasState(element);
    } catch (error) {
      console.error('Error during redo:', error);
    }
  }

  private async restoreCanvasState(
    element: UndoRedoCanvasElement
  ): Promise<void> {
    const allCtx = this.canvasManagerService.getAllCanvasCtx();

    allCtx.forEach((ctx, index) => {
      if (!ctx) return;

      let sourceCanvas: OffscreenCanvas;

      if (Array.isArray(element.data)) {
        sourceCanvas = element.data[index];
      } else if (element.index !== index) {
        return;
      } else {
        sourceCanvas = element.data;
      }

      // Simple, synchronous restore
      ctx.clearRect(0, 0, this.stateService.width, this.stateService.height);
      ctx.drawImage(sourceCanvas, 0, 0);
    });

    this.redrawRequest.next(true);
  }

  empty() {
    UndoRedo.empty();
  }

  public async update_undo_redo(): Promise<void> {
    if (this.editorService.affectsMultipleLabels()) {
      const allCanvas = this.canvasManagerService.getAllCanvas();
      const clonedCanvases = allCanvas.map((canvas) => {
        const clone = new OffscreenCanvas(canvas.width, canvas.height);
        const cloneCtx = clone.getContext('2d');
        cloneCtx?.drawImage(canvas, 0, 0);
        return clone;
      });

      UndoRedo.push({ data: clonedCanvases, index: -1 });
    } else {
      const activeCanvas = this.canvasManagerService.getActiveCanvas();
      const clone = new OffscreenCanvas(
        activeCanvas.width,
        activeCanvas.height
      );
      const cloneCtx = clone.getContext('2d');
      cloneCtx?.drawImage(activeCanvas, 0, 0);

      UndoRedo.push({
        data: clone,
        index: this.labelService.getActiveIndex(),
      });
    }
  }
}
