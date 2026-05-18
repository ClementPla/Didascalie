import { TestBed } from '@angular/core/testing';

import { PyramidService } from './pyramid.service';

describe('PyramidService', () => {
  let service: PyramidService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PyramidService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
