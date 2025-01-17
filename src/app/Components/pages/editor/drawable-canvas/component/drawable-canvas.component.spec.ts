import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DrawableCanvasComponent } from './drawable-canvas.component';

describe('DrawableCanvasComponent', () => {
  let component: DrawableCanvasComponent;
  let fixture: ComponentFixture<DrawableCanvasComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DrawableCanvasComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(DrawableCanvasComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
