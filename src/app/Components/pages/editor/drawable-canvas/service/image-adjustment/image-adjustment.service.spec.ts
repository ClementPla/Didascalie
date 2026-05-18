import { TestBed } from '@angular/core/testing';

import { ImageAdjustmentService } from './image-adjustment.service';

describe('ImageAdjustmentService', () => {
  let service: ImageAdjustmentService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ImageAdjustmentService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
