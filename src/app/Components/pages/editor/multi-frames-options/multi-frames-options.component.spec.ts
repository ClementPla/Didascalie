import { ComponentFixture, TestBed } from '@angular/core/testing';

import { MultiFramesOptionsComponent } from './multi-frames-options.component';

describe('MultiFramesOptionsComponent', () => {
  let component: MultiFramesOptionsComponent;
  let fixture: ComponentFixture<MultiFramesOptionsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MultiFramesOptionsComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(MultiFramesOptionsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
