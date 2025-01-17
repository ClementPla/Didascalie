import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InstanceLabelComponent } from './instance-label.component';

describe('InstanceLabelComponent', () => {
  let component: InstanceLabelComponent;
  let fixture: ComponentFixture<InstanceLabelComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InstanceLabelComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(InstanceLabelComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
