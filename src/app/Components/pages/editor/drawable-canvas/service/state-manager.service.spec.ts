import { TestBed } from '@angular/core/testing';

import { StateManagerService } from './state-manager.service';

describe('StateManagerService', () => {
  let service: StateManagerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(StateManagerService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
