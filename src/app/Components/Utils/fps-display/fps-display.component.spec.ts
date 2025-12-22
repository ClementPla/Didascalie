import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FpsDisplayComponent } from './fps-display.component';

describe('FpsDisplayComponent', () => {
  let component: FpsDisplayComponent;
  let fixture: ComponentFixture<FpsDisplayComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FpsDisplayComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(FpsDisplayComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
