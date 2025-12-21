import { TestBed } from '@angular/core/testing';

import { ProjectRevisionService } from './project-revision.service';

describe('ProjectRevisionService', () => {
  let service: ProjectRevisionService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ProjectRevisionService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
