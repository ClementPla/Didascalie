import { TestBed } from '@angular/core/testing';

import { SVGUIService } from './svgui.service';

describe('SVGUIService', () => {
  let service: SVGUIService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(SVGUIService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
