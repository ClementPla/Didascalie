import { TestBed } from '@angular/core/testing';

import { OrchestratorService } from './orchestrator.service';

describe('OrchestratorService', () => {
  let service: OrchestratorService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(OrchestratorService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
