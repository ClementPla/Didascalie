// fps-display.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FpsWorkerService } from './fps.service';
import { RenderStatsService } from './render-stats.service';

@Component({
  selector: 'app-fps-display',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './fps-display.component.html',
  styleUrl: './fps-display.component.scss',
})
export class FpsDisplayComponent implements OnInit, OnDestroy {
  constructor(
    public service: FpsWorkerService,
    public stats: RenderStatsService,
  ) {}

  ngOnInit() {
    // The overlay only exists while the counter is shown, so gate the render
    // probes on its lifecycle: no measurement cost when hidden.
    this.stats.reset();
    this.stats.enabled = true;
    this.service.start();
  }

  ngOnDestroy() {
    this.stats.enabled = false;
    this.service.stop();
  }
}
