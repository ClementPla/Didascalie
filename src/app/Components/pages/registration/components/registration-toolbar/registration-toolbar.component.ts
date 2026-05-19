// Components/pages/registration/components/registration-toolbar/registration-toolbar.component.ts

import { ChangeDetectionStrategy, Component, EventEmitter, inject, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ButtonModule } from 'primeng/button';
import { SliderModule } from 'primeng/slider';

import {
  RegistrationStateService,
  VisualizationMode,
} from '../../registration-state.service';

interface ModeOption {
  label: string;
  value: VisualizationMode;
  icon: string;
}

@Component({
  selector: 'app-registration-toolbar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, ButtonModule, SliderModule],
  templateUrl: './registration-toolbar.component.html',
  styleUrl: './registration-toolbar.component.scss',
})
export class RegistrationToolbarComponent {
  // registration-toolbar.component.ts — add
  @Output() previousClicked = new EventEmitter<void>();
  @Output() nextClicked = new EventEmitter<void>();
  @Output() saveClicked = new EventEmitter<void>();
  @Output() openCompositeClicked = new EventEmitter<void>();

  onPrevious(): void {
    this.previousClicked.emit();
  }
  onNext(): void {
    this.nextClicked.emit();
  }
  onSave(): void {
    this.saveClicked.emit();
  }
  onOpenComposite(): void {
    this.openCompositeClicked.emit();
  }
  readonly state = inject(RegistrationStateService);

  readonly modeOptions: ModeOption[] = [
    { label: 'Side by side', value: 'side-by-side', icon: 'pi pi-table' },
    { label: 'Overlay', value: 'overlay', icon: 'pi pi-clone' },
    { label: 'Checkerboard', value: 'checkerboard', icon: 'pi pi-th-large' },
  ];

  // Reactive views, aliased for the template.
  readonly mode = this.state.mode;
  readonly vis = this.state.vis;


  setMode(mode: VisualizationMode): void {
    this.state.setMode(mode);
  }

  // Two-way binding shims for sliders / toggles.
  get overlayOpacity(): number {
    return this.vis().overlayOpacity;
  }
  set overlayOpacity(v: number) {
    this.state.setOverlayOpacity(v);
  }

  get checkerTileSize(): number {
    return this.vis().checkerTileSize;
  }
  set checkerTileSize(v: number) {
    this.state.setCheckerTileSize(v);
  }

  get syncPanZoom(): boolean {
    return this.vis().syncPanZoom;
  }
  set syncPanZoom(v: boolean) {
    this.state.setSyncPanZoom(v);
  }

  get showMovingWarped(): boolean {
    return this.vis().showMovingWarped;
  }
  set showMovingWarped(v: boolean) {
    this.state.setShowMovingWarped(v);
  }

  get showShadowCursor(): boolean {
    return this.vis().showShadowCursor;
  }
  set showShadowCursor(v: boolean) {
    this.state.setShowShadowCursor(v);
  }
}
