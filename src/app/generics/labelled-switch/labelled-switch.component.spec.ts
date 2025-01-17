import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LabelledSwitchComponent } from './labelled-switch.component';

describe('LabelledSwitchComponent', () => {
  let component: LabelledSwitchComponent;
  let fixture: ComponentFixture<LabelledSwitchComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LabelledSwitchComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(LabelledSwitchComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
