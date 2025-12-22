import { TestBed } from '@angular/core/testing';

import { CLIService } from './cli.service';

describe('CLIService', () => {
  let service: CLIService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CLIService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
