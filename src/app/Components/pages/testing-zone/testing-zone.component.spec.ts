import { ComponentFixture, TestBed } from '@angular/core/testing';

import { TestingZoneComponent } from './testing-zone.component';

describe('TestingZoneComponent', () => {
  let component: TestingZoneComponent;
  let fixture: ComponentFixture<TestingZoneComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestingZoneComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(TestingZoneComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
