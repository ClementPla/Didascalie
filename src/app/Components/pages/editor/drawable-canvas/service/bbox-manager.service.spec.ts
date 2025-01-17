import { TestBed } from '@angular/core/testing';

import { BboxManagerService } from './bbox-manager.service';

describe('BboxManagerService', () => {
  let service: BboxManagerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(BboxManagerService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
