import { ComponentFixture, TestBed } from '@angular/core/testing';

import { BlockableP } from './p.component';

describe('BlockableP', () => {
  let component: BlockableP;
  let fixture: ComponentFixture<BlockableP>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [BlockableP]
    })
    .compileComponents();

    fixture = TestBed.createComponent(BlockableP);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
