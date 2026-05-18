import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PixelsConfigurationComponent } from './pixels-configuration.component';

describe('PixelsConfigurationComponent', () => {
  let component: PixelsConfigurationComponent;
  let fixture: ComponentFixture<PixelsConfigurationComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PixelsConfigurationComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PixelsConfigurationComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
