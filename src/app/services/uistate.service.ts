import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

export interface LoadingState {
  isLoading: boolean;
  message: string;
}

/**
 * Manages application-level UI state.
 * 
 * Responsibilities:
 * - Loading indicators and messages
 * - Route navigation
 * - UI preferences (thumbnails size, etc.)
 */
@Injectable({
  providedIn: 'root',
})
export class UIStateService {
  private router = inject(Router);

  /**
   * Signals rather than plain fields, because templates read these directly.
   * Reading a signal in a template marks that view dirty on change; reading a
    * plain property does not, so a component using OnPush would stop repainting
    * when this state moved.
   */
  private readonly loadingState = signal<LoadingState>({
    isLoading: false,
    message: '',
  });

  readonly isLoading = computed(() => this.loadingState().isLoading);
  readonly loadingStatus = computed(() => this.loadingState().message);

  // UI preferences
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