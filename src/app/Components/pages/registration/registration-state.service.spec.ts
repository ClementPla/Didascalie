import { TestBed } from '@angular/core/testing';

import { RegistrationStateService } from './registration-state.service';

describe('RegistrationStateService', () => {
  let service: RegistrationStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(RegistrationStateService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
