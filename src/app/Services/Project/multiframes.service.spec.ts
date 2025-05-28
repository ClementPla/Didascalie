import { TestBed } from '@angular/core/testing';

import { MultiframesService } from './multiframes.service';

describe('MultiframesService', () => {
  let service: MultiframesService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(MultiframesService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
