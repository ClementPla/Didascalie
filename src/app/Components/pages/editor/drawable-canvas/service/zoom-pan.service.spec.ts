import { TestBed } from '@angular/core/testing';

import { ZoomPanService } from './zoom-pan.service';

describe('ZoomPanService', () => {
  let service: ZoomPanService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ZoomPanService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
