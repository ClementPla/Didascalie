import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PopoutCompositeViewportComponent } from './popout-composite-viewport.component';

describe('PopoutCompositeViewportComponent', () => {
  let component: PopoutCompositeViewportComponent;
  let fixture: ComponentFixture<PopoutCompositeViewportComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PopoutCompositeViewportComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PopoutCompositeViewportComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
