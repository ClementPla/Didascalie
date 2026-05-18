import { TestBed } from '@angular/core/testing';

import { FrameLoaderService } from './frame-loader.service';

describe('FrameLoaderService', () => {
  let service: FrameLoaderService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(FrameLoaderService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
