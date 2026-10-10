import { ErrorHandler, Injectable, Injector, NgZone, inject } from '@angular/core';
import { NotificationService } from './notification.service';

/**
 * Logs unhandled runtime errors (and, via main.ts, unhandled promise
 * rejections) and shows them to the user. Services are resolved lazily
 * through the Injector: they are built after the error handler.
 */
@Injectable()
export class GlobalErrorHandler implements ErrorHandler {
  private readonly injector = inject(Injector);
  private readonly zone = inject(NgZone);

  handleError(error: unknown): void {
    console.error('[Unhandled error]', error);

    // NG0100 and the like are thrown only by the development build.
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
    // Tauri command rejections often arrive as plain strings or objects.
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}
