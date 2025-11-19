import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PixiCanvasComponent } from './pixi-canvas.component';

describe('PixiCanvasComponent', () => {
  let component: PixiCanvasComponent;
  let fixture: ComponentFixture<PixiCanvasComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PixiCanvasComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PixiCanvasComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
