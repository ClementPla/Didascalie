import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BlockableDiv } from './div.component';

describe('BlockableDiv', () => {
  let component: BlockableDiv;
  let fixture: ComponentFixture<BlockableDiv>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BlockableDiv]
    })
    .compileComponents();

    fixture = TestBed.createComponent(BlockableDiv);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
