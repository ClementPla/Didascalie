import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export type NotificationSeverity =
  | 'success'
  | 'info'
  | 'warn'
  | 'error'
  | 'secondary';

export interface AppNotification {
  severity: NotificationSeverity;
  summary: string;
  detail?: string;
  /** Toast lifetime in ms. */
  life?: number;
}

/** User-facing toasts, rendered by the shell through one global p-toast, and
 *  the "critical error" state of the blocking error screen. */
@Injectable({ providedIn: 'root' })
export class NotificationService {
  private readonly _toast = new Subject<AppNotification>();
  readonly toast$ = this._toast.asObservable();

  /** Non-null when a non-recoverable error has occurred. */
  readonly criticalError = signal<string | null>(null);

  notify(notification: AppNotification): void {
    this._toast.next(notification);
  }

  success(summary: string, detail?: string): void {
    this.notify({ severity: 'success', summary, detail });
  }
  info(summary: string, detail?: string): void {
    this.notify({ severity: 'info', summary, detail });
  }
  warn(summary: string, detail?: string): void {
    this.notify({ severity: 'warn', summary, detail });
  }
  error(summary: string, detail?: string): void {
    this.notify({ severity: 'error', summary, detail });
  }

  setCriticalError(message: string): void {
    this.criticalError.set(message);
  }

  clearCriticalError(): void {
    this.criticalError.set(null);
  }
}
