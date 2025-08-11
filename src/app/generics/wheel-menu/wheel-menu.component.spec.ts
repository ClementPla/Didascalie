import { ComponentFixture, TestBed } from '@angular/core/testing';

import { WheelMenuComponent } from './wheel-menu.component';

describe('WheelMenuComponent', () => {
  let component: WheelMenuComponent;
  let fixture: ComponentFixture<WheelMenuComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [WheelMenuComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(WheelMenuComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
