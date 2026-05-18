import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ImageAdjustmentsComponent } from './image-adjustments.component';

describe('ImageAdjustmentsComponent', () => {
  let component: ImageAdjustmentsComponent;
  let fixture: ComponentFixture<ImageAdjustmentsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ImageAdjustmentsComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ImageAdjustmentsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
