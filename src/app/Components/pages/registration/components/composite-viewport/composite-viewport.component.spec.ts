import { ComponentFixture, TestBed } from '@angular/core/testing';

import { CompositeViewportComponent } from './composite-viewport.component';

describe('CompositeViewportComponent', () => {
  let component: CompositeViewportComponent;
  let fixture: ComponentFixture<CompositeViewportComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [CompositeViewportComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(CompositeViewportComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
