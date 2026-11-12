import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';

import { IOService } from './io.service';
import { LabelsService } from './labels/labels.service';
import { SequenceService } from './sequence.service';
import { NotificationService } from './notification.service';
import { MaskVolumeService } from './mask-volume.service';
import { CanvasManagerService } from '../features/editor/drawable-canvas/service/canvas-manager.service';
import { StateManagerService } from '../features/editor/drawable-canvas/service/state-manager.service';
import { VectorEditorService } from '../features/editor/drawable-canvas/service/vector-editor.service';
import { api } from '../lib/api';

describe('IOService saves', () => {
  let io: IOService;
  let currentFrameId: number;
  const masks = [new Uint8Array([1, 0]), new Uint8Array([0, 1])];
  const notifications = jasmine.createSpyObj('NotificationService', ['error', 'notify']);

  beforeEach(() => {
    currentFrameId = 7;
    notifications.error.calls.reset();
    TestBed.configureTestingModule({
      providers: [
        { provide: LabelsService, useValue: { listSegmentationLabels: [{ id: 10 }, { id: 11 }] } },
        { provide: SequenceService, useValue: { currentFrame: () => ({ id: currentFrameId }) } },
        { provide: CanvasManagerService, useValue: { labelMasks: masks, detachMasks: () => {} } },
        { provide: StateManagerService, useValue: {} },
        {
          provide: VectorEditorService,
          useValue: { changed$: new Subject<void>(), shapesByLabel: () => new Map() },
        },
        { provide: NotificationService, useValue: notifications },
        {
          provide: MaskVolumeService,
          useValue: {
            released$: new Subject<void>(),
            ready$: new Subject<void>(),
            markEdited: () => {},
            syncSaved: () => {},
            saveDirty: () => Promise.resolve(),
          },
        },
      ],
    });
    io = TestBed.inject(IOService);
    // As `load()` leaves it.
    (io as unknown as { loadedFrameId: number }).loadedFrameId = 7;
    spyOn(api, 'saveVectorAnnotations').and.resolveTo();
  });

  afterEach(() => io.ngOnDestroy());

  it('writes to the loaded frame, not the one navigation moved to', async () => {
    const save = spyOn(api, 'saveAnnotation').and.resolveTo();
    io.markLabelDirty(0);
    currentFrameId = 8;
    expect(await io.saveIfDirty()).toBeTrue();
    expect(save).toHaveBeenCalledOnceWith(7, 10, masks[0]);
    expect(io.isDirty()).toBeFalse();
  });

  it('keeps the changes queued when a save fails', async () => {
    const save = spyOn(api, 'saveAnnotation').and.rejectWith(new Error('disk full'));
    io.markLabelDirty(1);
    expect(await io.save()).toBeFalse();
    expect(io.isDirty()).toBeTrue();
    expect(notifications.error).toHaveBeenCalled();

    save.and.resolveTo();
    expect(await io.saveIfDirty()).toBeTrue();
    expect(save).toHaveBeenCalledWith(7, 11, masks[1]);
    expect(io.isDirty()).toBeFalse();
  });

  it('runs saves one at a time', async () => {
    let inFlight = 0;
    let most = 0;
    spyOn(api, 'saveAnnotation').and.callFake(async () => {
      most = Math.max(most, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    io.markLabelDirty(0);
    const first = io.save();
    io.markLabelDirty(1);
    const second = io.save();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(most).toBe(1);
  });
});
