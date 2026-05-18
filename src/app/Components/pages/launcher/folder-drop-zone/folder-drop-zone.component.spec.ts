import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FolderDropZoneComponent } from './folder-drop-zone.component';

describe('FolderDropZoneComponent', () => {
  let component: FolderDropZoneComponent;
  let fixture: ComponentFixture<FolderDropZoneComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FolderDropZoneComponent]
    })
    .compileComponents();

    fixture = TestBed.createComponent(FolderDropZoneComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
