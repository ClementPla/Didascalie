import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { PostProcessService } from './post-process.service';
import { CanvasManagerService } from './canvas-manager.service';
import { StateManagerService } from './state-manager.service';
import { ImageAdjustmentService } from './image-adjustment/image-adjustment.service';
import { ZoomPanService } from './zoom-pan.service';
import { EditorService } from '../../services/editor.service';
import { LabelsService } from '../../../../services/labels/labels.service';
import { ProjectService } from '../../../../services/project/project.service';
import { SequenceService } from '../../../../services/sequence.service';
import { PixelInfo, api } from '../../../../lib/api';

const RECT = { x: 10, y: 20, width: 2, height: 1 };

const INFO: PixelInfo = {
  width: 64,
  height: 64,
  channels: 2,
  sampleType: 'u16',
  significantBits: 12,
  isRgb8: false,
  ranges: [
    { min: 0, max: 4095 },
    { min: 0, max: 4095 },
  ],
};

describe('PostProcessService', () => {
  const pixelInfo = signal<PixelInfo | null>(INFO);
  let frameId = 5;
  const activeMask = new Uint8Array(64 * 64);
  const canvasImage = {
    getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(8) }) }),
  };
  let service: PostProcessService;
  let editor: EditorService;

  beforeEach(() => {
    pixelInfo.set(INFO);
    activeMask.fill(0);
    frameId = 5;
    spyOn(api, 'otsuSegmentationRaw').and.resolveTo(new Uint8Array([255, 0]).buffer);
    spyOn(api, 'floodFillRaw').and.resolveTo(new Uint8Array([0, 255]).buffer);
    spyOn(api, 'otsuSegmentation').and.resolveTo(new Uint8Array([255, 255]).buffer);

    TestBed.configureTestingModule({
      providers: [
        {
          provide: SequenceService,
          useValue: { currentPixelInfo: pixelInfo, currentFrame: () => ({ id: frameId }) },
        },
        {
          provide: CanvasManagerService,
          useValue: {
            readBufferRegion: () => new Uint8ClampedArray(8).fill(255),
            getActiveMask: () => activeMask,
            getActiveIndex: () => 0,
            getAllMasks: () => [activeMask],
          },
        },
        { provide: StateManagerService, useValue: { width: 64, height: 64, strokeRect: () => RECT } },
        { provide: ImageAdjustmentService, useValue: { getCurrentCanvas: () => canvasImage } },
        { provide: ZoomPanService, useValue: { currentPixel: { x: 11, y: 20 } } },
        { provide: LabelsService, useValue: { paintValue: () => 1 } },
        { provide: ProjectService, useValue: { isInstanceSegmentation: () => false } },
      ],
    });
    service = TestBed.inject(PostProcessService);
    editor = TestBed.inject(EditorService);
    editor.operatorChannel = null;
  });

  it('runs Otsu on raw pixels for a rendered frame', async () => {
    await service.otsu_post_process();
    expect(api.otsuSegmentation).not.toHaveBeenCalled();
    const args = (api.otsuSegmentationRaw as jasmine.Spy).calls.mostRecent().args[0];
    expect(args).toEqual(jasmine.objectContaining({ frameId: 5, source: null, ...RECT }));
    expect(activeMask[20 * 64 + 10]).toBe(1);
    expect(activeMask[20 * 64 + 11]).toBe(0);
  });

  it('passes the chosen channel, and ignores one the frame lacks', async () => {
    editor.operatorChannel = 1;
    await service.flood_fill_post_process();
    let args = (api.floodFillRaw as jasmine.Spy).calls.mostRecent().args[0];
    expect(args).toEqual(jasmine.objectContaining({ source: 1, startX: 1, startY: 0 }));

    editor.operatorChannel = 4;
    await service.flood_fill_post_process();
    args = (api.floodFillRaw as jasmine.Spy).calls.mostRecent().args[0];
    expect(args.source).toBeNull();
  });

  it('drops a result that arrives after the frame changed', async () => {
    (api.otsuSegmentationRaw as jasmine.Spy).and.callFake(async () => {
      frameId = 6; // navigation while the command runs
      return new Uint8Array([255, 255]).buffer;
    });
    await service.otsu_post_process();
    expect(activeMask[20 * 64 + 10]).toBe(0);
  });

  it('keeps reading the canvas for an 8-bit image', async () => {
    pixelInfo.set(null);
    await service.otsu_post_process();
    expect(api.otsuSegmentationRaw).not.toHaveBeenCalled();
    expect(api.otsuSegmentation).toHaveBeenCalled();
  });
});
