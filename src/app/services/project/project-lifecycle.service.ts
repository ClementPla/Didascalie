import { Injectable, Injector, inject } from '@angular/core';

import { PROJECT_SCOPED, ProjectScoped } from '../../core/project-scoped';

/** Clears every [`ProjectScoped`] service when the open project changes. */
@Injectable({ providedIn: 'root' })
export class ProjectLifecycleService {
  /** Resolved on use: `ProjectService` calls this service, and several
   *  project-scoped services inject `ProjectService`. */
  private readonly injector = inject(Injector);

  /** Reset every registered service. One that throws is reported and skipped. */
  resetAll(): void {
    const scoped = this.injector.get<readonly ProjectScoped[]>(
      PROJECT_SCOPED,
      [],
    );
    for (const service of scoped) {
      try {
        service.resetForProject();
      } catch (error) {
        console.error(
          `[project] ${service.constructor.name}.resetForProject() failed`,
          error,
        );
      }
    }
  }
}
