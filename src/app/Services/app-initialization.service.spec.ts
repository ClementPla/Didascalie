import { TestBed } from '@angular/core/testing';

import { AppInitializationService } from './app-initialization.service';

describe('AppInitializationService', () => {
  let service: AppInitializationService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(AppInitializationService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
