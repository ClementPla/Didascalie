import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ClassificationConfigurationComponent } from './classification-configuration.component';

describe('ClassificationConfigurationComponent', () => {
  let component: ClassificationConfigurationComponent;
  let fixture: ComponentFixture<ClassificationConfigurationComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ClassificationConfigurationComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(ClassificationConfigurationComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
