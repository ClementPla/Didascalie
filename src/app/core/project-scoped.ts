import { InjectionToken } from '@angular/core';

/**
 * A root-provided service holding state that belongs to one open project.
 *
 * # Why this exists
 *
  * Route components are destroyed and rebuilt on navigation, so their fields
  * start clean. Services provided in `root` live as long as the app: without a
  * reset, opening a second project keeps the first one's sequences, filters,
  * masks, undo history and per-frame caches.
 *
 * The dangerous case is caches keyed by frame or label **id**, since ids
 * restart from 1 in every project: a stale entry is not obviously stale, it is
 * silently *wrong*, and reads as the new project having the old one's data.
 *
 * # The contract
 *
 * Implement this on any root service that stores something belonging to a
 * project, then register it in `app.config.ts`:
 *
 * ```ts
 * { provide: PROJECT_SCOPED, useExisting: MyService, multi: true }
 * ```
 *
 * That registration is the one place a new service can be forgotten, which is
 * why it is a single visible list rather than each service subscribing to a
 * lifecycle event on its own.
 *
 * User *preferences* that happen to live on such a service (thumbnail size,
 * grid vs list) are not project state and should survive a switch. Reset the
 * data, not the settings.
 */
export interface ProjectScoped {
  /**
   * Drop everything tied to the project being closed.
   *
   * Called before a project opens and again when one closes, so it must be
   * safe to run twice and safe to run when nothing was ever loaded. It must not
   * throw: one service failing cannot be allowed to leave the rest stale.
   */
  resetForProject(): void;
}

/** Every registered [`ProjectScoped`] service. See the interface docs. */
export const PROJECT_SCOPED = new InjectionToken<readonly ProjectScoped[]>(
  'PROJECT_SCOPED',
);
