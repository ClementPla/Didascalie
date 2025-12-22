import { TestBed } from '@angular/core/testing';

import { WebGPUCanvasCompositorService } from './web-gpucanvas-compositor.service';

describe('WebGPUCanvasCompositorService', () => {
  let service: WebGPUCanvasCompositorService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(WebGPUCanvasCompositorService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
