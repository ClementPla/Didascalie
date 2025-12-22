// fps-display.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FpsWorkerService } from './fps.service';

@Component({
  selector: 'app-fps-display',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './fps-display.component.html',
  styleUrl: './fps-display.component.scss',
})
export class FpsDisplayComponent implements OnInit, OnDestroy {
  constructor(public service: FpsWorkerService) {}

  ngOnInit() {
    this.service.start();
  }

  ngOnDestroy() {
    this.service.stop();
  }
}