import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TextConfigurationComponent } from './text-configuration.component';

describe('TextConfigurationComponent', () => {
  let component: TextConfigurationComponent;
  let fixture: ComponentFixture<TextConfigurationComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextConfigurationComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TextConfigurationComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
