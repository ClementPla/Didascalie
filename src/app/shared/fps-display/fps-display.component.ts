import { Component, OnInit, OnDestroy, inject } from '@angular/core';
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
  service = inject(FpsWorkerService);
  stats = inject(RenderStatsService);

  ngOnInit() {
    // The render probes run only while the counter is shown.
    this.stats.reset();
    this.stats.enabled = true;
    this.service.start();
  }

  ngOnDestroy() {
    this.stats.enabled = false;
    this.service.stop();
  }
}
