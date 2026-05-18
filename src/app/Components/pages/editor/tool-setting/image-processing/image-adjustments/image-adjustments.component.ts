// image-adjustments.component.ts

import { ChangeDetectionStrategy, Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

import { TabsModule } from 'primeng/tabs';
import { SliderModule } from 'primeng/slider';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { TooltipModule } from 'primeng/tooltip';

import { CurveEditorComponent } from '../curve-editor/curve-editor.component';
import { ImageAdjustmentService } from '../../../drawable-canvas/service/image-adjustment/image-adjustment.service';
import {
  Channel,
  CurvePoints,
  Histogram,
} from '../../../drawable-canvas/service/image-adjustment/image-processing.model';

interface TabSpec {
  id: 'rgb' | 'r' | 'g' | 'b';
  label: string;
  color: string;          // curve / accent color
  sliderTarget: Channel;  // which channel adjusts B/C/G affect
  curveTarget: Channel;   // which channel the curve edits
  histKey: keyof Pick<Histogram, 'r' | 'g' | 'b' | 'luma'>;
}

@Component({
  selector: 'app-image-adjustments',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    TabsModule,
    SliderModule,
    ButtonModule,
    InputTextModule,
    TooltipModule,
    CurveEditorComponent,
  ],
  templateUrl: './image-adjustments.component.html',
  styleUrl: './image-adjustments.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImageAdjustmentsComponent implements OnInit, OnDestroy {
  readonly tabs: TabSpec[] = [
    { id: 'rgb', label: 'RGB', color: '#e0e0e0', sliderTarget: 'luma', curveTarget: 'luma', histKey: 'luma' },
    { id: 'r',   label: 'R',   color: '#e35d6a', sliderTarget: 'r',    curveTarget: 'r',    histKey: 'r'    },
    { id: 'g',   label: 'G',   color: '#5fb874', sliderTarget: 'g',    curveTarget: 'g',    histKey: 'g'    },
    { id: 'b',   label: 'B',   color: '#4c8df6', sliderTarget: 'b',    curveTarget: 'b',    histKey: 'b'    },
  ];

  activeTab: string = 'rgb';
  histogram: Histogram | null = null;

  private destroy$ = new Subject<void>();

  constructor(public service: ImageAdjustmentService) {}

  ngOnInit() {
    this.service.histogram$
      .pipe(takeUntil(this.destroy$))
      .subscribe(h => { this.histogram = h; });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ==========================================
  // State access (used by template; OnPush re-renders when these change
  // via two-way binding setters below)
  // ==========================================

  brightness(ch: Channel): number { return this.service.state[ch].brightness; }
  contrast(ch: Channel):   number { return this.service.state[ch].contrast; }
  gamma(ch: Channel):      number { return this.service.state[ch].gamma; }
  curve(ch: Channel):      CurvePoints { return this.service.state[ch].curve; }

  setBrightness(ch: Channel, v: number) { this.service.setAdjustment(ch, 'brightness', this.clamp(v, -100, 100)); }
  setContrast(ch: Channel, v: number)   { this.service.setAdjustment(ch, 'contrast',   this.clamp(v, -100, 100)); }
  setGamma(ch: Channel, v: number)      { this.service.setAdjustment(ch, 'gamma',      this.clamp(v, 0.1, 3.0)); }

  onCurveChange(ch: Channel, pts: CurvePoints) {
    this.service.setCurve(ch, pts);
  }

  histogramFor(key: TabSpec['histKey']): Uint32Array | null {
    return this.histogram ? this.histogram[key] : null;
  }

  // ==========================================
  // Actions
  // ==========================================

  autoStretch() { this.service.autoStretch(); }
  equalize()    { this.service.equalize(); }

  resetTab(tab: TabSpec) {
    this.service.resetChannel(tab.sliderTarget);
    if (tab.curveTarget !== tab.sliderTarget) {
      this.service.resetChannel(tab.curveTarget);
    }
  }

  resetAll() { this.service.resetAll(); }

  private clamp(v: number, lo: number, hi: number) { return v < lo ? lo : v > hi ? hi : v; }
}