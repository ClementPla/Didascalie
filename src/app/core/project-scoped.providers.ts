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
import { RegistrationStateService } from '../features/registration/registration-state.service';
import { CanvasManagerService } from '../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../features/editor/drawable-canvas/service/state-manager.service';
import { VectorEditorService } from '../features/editor/drawable-canvas/service/vector-editor.service';
import { UndoRedoService } from '../features/editor/drawable-canvas/service/undo-redo.service';
import { BboxManagerService } from '../features/editor/drawable-canvas/service/bbox-manager.service';
import { TiledImageService } from '../features/editor/drawable-canvas/service/tiled-image.service';

/**
 * Services holding state that belongs to one project, cleared whenever the open
 * project changes. See `core/project-scoped.ts` for the contract.
 *
 * This list is the one place a new service can be forgotten. If something from
 * a previous project survives a switch, either its service is missing here or
 * its `resetForProject` does not go far enough.
 *
 * It lives here rather than in `app.config.ts` so that reaching into a
 * feature's internals — the canvas services are five directories down inside
 * `features/editor` — is contained in a file whose job is exactly that, instead
 * of being the bulk of the application's bootstrap.
 */
const PROJECT_SCOPED_SERVICES = [
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
  CanvasManagerService,
  StateManagerService,
  VectorEditorService,
  UndoRedoService,
  BboxManagerService,
  TiledImageService,
];

/** Register every project-scoped service under the {@link PROJECT_SCOPED} token. */
export function provideProjectScoped(): Provider[] {
  return PROJECT_SCOPED_SERVICES.map((useExisting) => ({
    provide: PROJECT_SCOPED,
    useExisting,
    multi: true,
  }));
}
