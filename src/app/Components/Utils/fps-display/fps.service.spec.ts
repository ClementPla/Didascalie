import { TestBed } from '@angular/core/testing';

import { FpsWorkerService } from './fps.service';

describe('FpsWorkerService', () => {
  let service: FpsWorkerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(FpsWorkerService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
