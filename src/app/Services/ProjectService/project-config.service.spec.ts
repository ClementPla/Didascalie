import { TestBed } from '@angular/core/testing';

import { ProjectConfigService } from './project-config.service';

describe('ProjectConfigService', () => {
  let service: ProjectConfigService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ProjectConfigService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
