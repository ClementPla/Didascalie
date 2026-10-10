import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ProjectService } from '../services/project/project.service';
import { UserService } from '../services/users/user.service';

/** A project is open. Enough for the account picker. */
export const projectOpenGuard: CanActivateFn = () => {
  if (inject(ProjectService).isOpen()) return true;
  return inject(Router).createUrlTree(['']);
};

/** A project is open and someone is logged in: annotations are per user. */
export const projectStartedGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const users = inject(UserService);
  if (!inject(ProjectService).isOpen()) return router.createUrlTree(['']);
  if (!(await users.ensureSession())) return router.createUrlTree(['/users']);
  return true;
};

/** Pages that change what every user shares, or compare users. */
export const adminGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const users = inject(UserService);
  if (!inject(ProjectService).isOpen()) return router.createUrlTree(['']);
  if (!(await users.ensureSession())) return router.createUrlTree(['/users']);
  return users.isAdmin() ? true : router.createUrlTree(['/gallery']);
};
