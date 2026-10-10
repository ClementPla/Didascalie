import { Injectable, inject } from '@angular/core';

import {
  AddImagesResult,
  EditImpact,
  ProjectEdit,
  ScanOptions,
  api,
} from '../../lib/api';
import { ProjectScoped } from '../../core/project-scoped';
import { IOService } from '../../services/io.service';
import { ClassificationService } from '../../services/labels/classification.service';
import { MaskVolumeService } from '../../services/mask-volume.service';
import { ProjectService } from '../../services/project/project.service';
import { SequenceService } from '../../services/sequence.service';
import { BboxManagerService } from '../editor/drawable-canvas/service/bbox-manager.service';
import { CanvasManagerService } from '../editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../editor/drawable-canvas/service/state-manager.service';
import { UndoRedoService } from '../editor/drawable-canvas/service/undo-redo.service';
import { VectorEditorService } from '../editor/drawable-canvas/service/vector-editor.service';

/**
 * Changes the configuration of the open project.
 *
 * The editor's services outlive the editor page and still hold the last
 * frame: one mask per label by position in the label list, its shapes, its
 * undo history, maybe a pending save. So every edit is bracketed:
 *
 * 1. Before: flush the pending save, while positions still mean what they
 *    meant when the strokes were made.
 * 2. After: drop the editor's frame state, which is reloaded from the project
 *    against the new definitions.
 *
 * The open sequence and frame are left alone.
 */
@Injectable({ providedIn: 'root' })
export class ProjectSettingsService {
  private readonly project = inject(ProjectService);
  private readonly io = inject(IOService);
  private readonly sequences = inject(SequenceService);

  /** Holders of per-frame state derived from the project's definitions. */
  private readonly frameState: readonly ProjectScoped[] = [
    inject(CanvasManagerService),
    inject(StateManagerService),
    inject(VectorEditorService),
    inject(UndoRedoService),
    inject(BboxManagerService),
    inject(MaskVolumeService),
    inject(ClassificationService),
  ];

  /** What `edit` would permanently delete, counting unsaved work too. */
  async impact(edit: ProjectEdit): Promise<EditImpact> {
    await this.flush();
    return api.projectEditImpact(edit);
  }

  async apply(edit: ProjectEdit): Promise<void> {
    await this.flush();
    await this.project.applyEdit(edit);
    for (const service of this.frameState) service.resetForProject();
  }

  async addImages(options: ScanOptions): Promise<AddImagesResult> {
    const result = await this.project.addImages(options);
    if (result.framesImported > 0) await this.sequences.loadSequences();
    return result;
  }

  private async flush(): Promise<void> {
    if (!(await this.io.saveIfDirty())) {
      throw new Error(
        'The frame open in the editor could not be saved, so nothing was changed.',
      );
    }
  }
}
