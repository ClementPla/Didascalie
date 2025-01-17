import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProjectConfigurationComponent } from './project-configuration.component';

describe('ProjectConfigurationComponent', () => {
  let component: ProjectConfigurationComponent;
  let fixture: ComponentFixture<ProjectConfigurationComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ProjectConfigurationComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(ProjectConfigurationComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
