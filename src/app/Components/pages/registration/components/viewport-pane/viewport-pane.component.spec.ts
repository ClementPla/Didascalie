import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ViewportPaneComponent } from './viewport-pane.component';

describe('ViewportPaneComponent', () => {
  let component: ViewportPaneComponent;
  let fixture: ComponentFixture<ViewportPaneComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ViewportPaneComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ViewportPaneComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
