import { TestBed } from '@angular/core/testing';

import { TauriEventService } from './tauri-event.service';

describe('TauriEventService', () => {
  let service: TauriEventService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(TauriEventService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
