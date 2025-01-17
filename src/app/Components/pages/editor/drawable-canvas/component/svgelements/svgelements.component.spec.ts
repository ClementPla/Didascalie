import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SVGElementsComponent } from './svgelements.component';

describe('SVGElementsComponent', () => {
  let component: SVGElementsComponent;
  let fixture: ComponentFixture<SVGElementsComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SVGElementsComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(SVGElementsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
