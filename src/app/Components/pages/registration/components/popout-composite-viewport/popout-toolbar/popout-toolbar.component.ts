// Components/pages/registration/popout-composite-viewport/popout-toolbar.component.ts

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { SliderModule } from 'primeng/slider';

import {
  RegistrationStateService,
  VisualizationMode,
} from '../../../registration-state.service';

interface ModeOption {
  label: string;
  value: VisualizationMode;
  icon:  string;
}

/**
 * Toolbar for the detached popout window. Has only the controls that make
 * sense in that context: mode selection (overlay / checkerboard, not
 * side-by-side), and the active mode's slider (opacity or tile size).
 *
 * Mutates the popout's local RegistrationStateService — the main window has
 * its own state service and its own toolbar.
 */
@Component({
  selector: 'app-popout-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SliderModule],
  templateUrl: './popout-toolbar.component.html',
  styleUrl:    './popout-toolbar.component.scss',
})
export class PopoutToolbarComponent {
  readonly state = inject(RegistrationStateService);

  readonly modeOptions: ModeOption[] = [
    { label: 'Overlay',      value: 'overlay',      icon: 'pi pi-clone' },
    { label: 'Checkerboard', value: 'checkerboard', icon: 'pi pi-th-large' },
  ];

  readonly mode = this.state.mode;
  readonly vis  = this.state.vis;

  setMode(mode: VisualizationMode): void {
    this.state.setMode(mode);
  }

  get overlayOpacity(): number   { return this.vis().overlayOpacity; }
  set overlayOpacity(v: number)  { this.state.setOverlayOpacity(v); }

  get checkerTileSize(): number  { return this.vis().checkerTileSize; }
  set checkerTileSize(v: number) { this.state.setCheckerTileSize(v); }
}