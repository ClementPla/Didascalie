import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ToolSettingComponent } from './tool-setting.component';

describe('ToolSettingComponent', () => {
  let component: ToolSettingComponent;
  let fixture: ComponentFixture<ToolSettingComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolSettingComponent]
    })
    .compileComponents();
    
    fixture = TestBed.createComponent(ToolSettingComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
