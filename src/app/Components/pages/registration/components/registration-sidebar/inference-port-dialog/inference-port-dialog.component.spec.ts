import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InferencePortDialogComponent } from './inference-port-dialog.component';

describe('InferencePortDialogComponent', () => {
  let component: InferencePortDialogComponent;
  let fixture: ComponentFixture<InferencePortDialogComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InferencePortDialogComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(InferencePortDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
