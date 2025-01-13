import { TestBed } from '@angular/core/testing';

import { PostProcessService } from './post-process.service';

describe('PostProcessService', () => {
  let service: PostProcessService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PostProcessService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
