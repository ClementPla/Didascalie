import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ProjectService } from '../Services/ProjectService/project.service';

export const projectStartedGuard: CanActivateFn = (route, state) => {

  const projectService = inject(ProjectService);
  const router = inject(Router);
  console.log('Is project started?', projectService.isProjectStarted);
  if (!projectService.isProjectStarted) {
    router.navigate(['/project-configuration']);
  }
  
  return projectService.isProjectStarted;
};
