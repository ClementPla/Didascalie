// ui-state.service.ts
import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

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
  // Loading state
  private loadingSubject = new BehaviorSubject<LoadingState>({ 
    isLoading: false, 
    message: '' 
  });
  public loading$ = this.loadingSubject.asObservable();

  // UI preferences
  public thumbnailsSize = 128;

  public showFpsCounter = false;

  constructor(private router: Router) {}

  // ==========================================
  // Loading State Management
  // ==========================================

  public setLoading(isLoading: boolean, message = ''): void {
    this.loadingSubject.next({ isLoading, message });
  }

  public endLoading(): void {
    this.loadingSubject.next({ isLoading: false, message: '' });
  }

  // Legacy getters for backward compatibility
  public get isLoading(): boolean {
    return this.loadingSubject.value.isLoading;
  }

  public get loadingStatus(): string {
    return this.loadingSubject.value.message;
  }

  // ==========================================
  // Route Navigation
  // ==========================================

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