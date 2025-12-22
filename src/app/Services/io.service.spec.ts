import { TestBed } from '@angular/core/testing';

import { IOService } from './io.service';

describe('IOService', () => {
  let service: IOService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(IOService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
