import { Provider } from '@angular/core';

import { PROJECT_SCOPED } from './project-scoped';

import { SequenceService } from '../services/sequence.service';
import { IOService } from '../services/io.service';
import { MaskVolumeService } from '../services/mask-volume.service';
import { ProjectionService } from '../experimental/volume3d/projection/projection.service';
import { ProjectionPainterService } from '../experimental/volume3d/projection/projection-painter.service';
import { PyramidService } from '../services/pyramid.service';
import { LabelsService } from '../services/labels/labels.service';
import { ClassificationService } from '../services/labels/classification.service';
import { GalleryService } from '../features/gallery/gallery.service';
import { UserService } from '../services/users/user.service';
import { RegistrationStateService } from '../features/registration/registration-state.service';
import { InspectionService } from '../features/inspect/inspection.service';
import { CanvasManagerService } from '../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../features/editor/drawable-canvas/service/state-manager.service';
import { VectorEditorService } from '../features/editor/drawable-canvas/service/vector-editor.service';
import { UndoRedoService } from '../features/editor/drawable-canvas/service/undo-redo.service';
import { BboxManagerService } from '../features/editor/drawable-canvas/service/bbox-manager.service';
import { TiledImageService } from '../features/editor/drawable-canvas/service/tiled-image.service';

/**
 * Services holding state that belongs to one project, cleared when the open
 * project changes (see `core/project-scoped.ts`). A service missing from this
 * list keeps the previous project's state.
 */
const PROJECT_SCOPED_SERVICES = [
  UserService,
  SequenceService,
  IOService,
  MaskVolumeService,
  ProjectionService,
  ProjectionPainterService,
  PyramidService,
  LabelsService,
  ClassificationService,
  GalleryService,
  RegistrationStateService,
  InspectionService,
  CanvasManagerService,
  StateManagerService,
  VectorEditorService,
  UndoRedoService,
  BboxManagerService,
  TiledImageService,
];

export function provideProjectScoped(): Provider[] {
  return PROJECT_SCOPED_SERVICES.map((useExisting) => ({
    provide: PROJECT_SCOPED,
    useExisting,
    multi: true,
  }));
}
