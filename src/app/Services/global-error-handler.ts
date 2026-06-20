import { ErrorHandler, Injectable, Injector, NgZone } from '@angular/core';
import { NotificationService } from './notification.service';

/**
 * Catches otherwise-unhandled runtime errors (and, via main.ts, unhandled
 * promise rejections) so they are both logged for diagnostics and surfaced
 * to the user instead of failing silently.
 *
 * Uses the Injector lazily to avoid the circular-DI trap that comes from a
 * provider for ErrorHandler depending on services that are themselves built
 * after the error handler.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  constructor(
    private readonly injector: Injector,
    private readonly zone: NgZone,
  ) {}

  handleError(error: unknown): void {
    // Always keep the full error in the console for developers.
    console.error('[Unhandled error]', error);

    // Don't surface dev-only framework diagnostics to the user. NG0100
    // (ExpressionChangedAfterItHasBeenChecked) and friends are thrown only by
    // the development build's verification pass and never occur in production,
    // so a toast would be noise rather than an actionable error.
    if (this.isDevOnlyFrameworkError(error)) {
      return;
    }

    const detail = this.describe(error);
    this.zone.run(() => {
      try {
        this.injector
          .get(NotificationService)
          .error('Something went wrong', detail);
      } catch {
        // Notifications not available yet — the console log above still stands.
      }
    });
  }

  private isDevOnlyFrameworkError(error: unknown): boolean {
    const message =
      error instanceof Error ? error.message : String(error ?? '');
    return (
      message.includes('NG0100') ||
      message.includes('ExpressionChangedAfterItHasBeenChecked')
    );
  }

  private describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'string') return error;
    // Tauri command rejections often arrive as plain strings/objects.
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
