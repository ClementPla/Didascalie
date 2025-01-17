import { TestBed } from '@angular/core/testing';

import { CanvasManagerService } from './canvas-manager.service';

describe('CanvasManagerService', () => {
  let service: CanvasManagerService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(CanvasManagerService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
