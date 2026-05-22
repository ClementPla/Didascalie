import { TestBed } from '@angular/core/testing';

import { InferenceClientService } from './inference-client.service';

describe('InferenceClientService', () => {
  let service: InferenceClientService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(InferenceClientService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
