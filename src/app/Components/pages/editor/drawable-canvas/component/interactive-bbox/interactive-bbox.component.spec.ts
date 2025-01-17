import { ComponentFixture, TestBed } from '@angular/core/testing';

import { InteractiveBboxComponent } from './interactive-bbox.component';

describe('InteractiveBboxComponent', () => {
  let component: InteractiveBboxComponent;
  let fixture: ComponentFixture<InteractiveBboxComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InteractiveBboxComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(InteractiveBboxComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
