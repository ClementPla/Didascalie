import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

export interface LoadingState {
  isLoading: boolean;
  message: string;
}

/** Loading indicator, route navigation and UI preferences. */
@Injectable({
  providedIn: 'root',
})
export class UIStateService {
  private router = inject(Router);

  /** Signals: templates read these directly, under OnPush. */
  private readonly loadingState = signal<LoadingState>({
    isLoading: false,
    message: '',
  });

  readonly isLoading = computed(() => this.loadingState().isLoading);
  readonly loadingStatus = computed(() => this.loadingState().message);

  readonly thumbnailsSize = signal(128);
  readonly showFpsCounter = signal(false);

  // ── Loading State Management ─────────────────────────────────────────────

  public setLoading(isLoading: boolean, message = ''): void {
    this.loadingState.set({ isLoading, message });
  }

  public endLoading(): void {
    this.loadingState.set({ isLoading: false, message: '' });
  }

  // ── Route Navigation ─────────────────────────────────────────────────────

  public navigateToGallery(): Promise<boolean> {
    return this.router.navigate(['/gallery']);
  }

  public navigateToEditor(): Promise<boolean> {
    return this.router.navigate(['/editor']);
  }

  public navigateToExport(): Promise<boolean> {
    return this.router.navigate(['/export']);
  }

  public navigateToTestZone(): Promise<boolean> {
    return this.router.navigate(['/testing-zone']);
  }
}