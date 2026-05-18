import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ProjectService } from '../Services/ProjectService/project.service';

export const projectStartedGuard: CanActivateFn = (route, state) => {
  const projectService = inject(ProjectService);
  const router = inject(Router);

  const isOpen = projectService.isOpen();


  if (!isOpen) {
    router.navigate(['']);
    return false;
  }

  return true;
};