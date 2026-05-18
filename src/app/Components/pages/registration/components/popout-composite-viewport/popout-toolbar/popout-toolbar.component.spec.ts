import { ComponentFixture, TestBed } from '@angular/core/testing';

import { PopoutToolbarComponent } from './popout-toolbar.component';

describe('PopoutToolbarComponent', () => {
  let component: PopoutToolbarComponent;
  let fixture: ComponentFixture<PopoutToolbarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PopoutToolbarComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(PopoutToolbarComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
