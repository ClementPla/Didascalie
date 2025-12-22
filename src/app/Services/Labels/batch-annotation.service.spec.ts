import { TestBed } from '@angular/core/testing';

import { BatchAnnotationService } from './batch-annotation.service';

describe('BatchAnnotationService', () => {
  let service: BatchAnnotationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(BatchAnnotationService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
