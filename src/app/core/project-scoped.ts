import { InjectionToken } from '@angular/core';

/**
 * A root-provided service holding state that belongs to one open project.
 *
 * Root services live as long as the app, and frame and label ids restart from
 * 1 in every project, so a cache keyed by id would silently serve the previous
 * project's data. Implement this and register the service in
 * `core/project-scoped.providers.ts`. User preferences kept on such a service
 * are not project state and should survive.
 */
export interface ProjectScoped {
  /**
   * Drop everything tied to the project being closed. Called before a project
   * opens and when one closes: it must be safe to run twice, and must not throw.
   */
  resetForProject(): void;
}

export const PROJECT_SCOPED = new InjectionToken<readonly ProjectScoped[]>(
  'PROJECT_SCOPED',
);
