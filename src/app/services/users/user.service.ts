import { Injectable, computed, inject, signal } from '@angular/core';

import { UserChange, UserFootprint, UserInfo, api } from '../../lib/api';
import { ProjectScoped } from '../../core/project-scoped';
import { IOService } from '../io.service';
import { LabelsService } from '../labels/labels.service';
import { ProjectLifecycleService } from '../project/project-lifecycle.service';
import { ProjectService } from '../project/project.service';

/**
 * Who is annotating the open project.
 *
 * The backend holds the session: logging in there is what makes every other
 * command read and write that user's annotations. This service mirrors it for
 * the UI and, more importantly, keeps the rest of the frontend honest when the
 * user changes.
 *
 * # Switching user is switching data
 *
 * Every project-scoped service caches things read through the previous user's
 * eyes: the masks on the canvas, the undo history, the gallery's progress, the
 * classification answers. After a switch all of it belongs to someone else, and
 * a save armed for the previous user would be written as the new one. So a
 * switch is bracketed like a project change:
 *
 * 1. flush the pending save **while the previous user is still logged in**;
 * 2. log in;
 * 3. reset every project-scoped service, then reload the label definitions
 *    that reset took with it (they are the project's, not the user's).
 */
@Injectable({ providedIn: 'root' })
export class UserService implements ProjectScoped {
  private readonly project = inject(ProjectService);
  private readonly labels = inject(LabelsService);
  private readonly lifecycle = inject(ProjectLifecycleService);
  private readonly io = inject(IOService);

  private readonly _current = signal<UserInfo | null>(null);
  private readonly _users = signal<UserInfo[]>([]);

  /** The logged-in account, or null while the project waits for one. */
  readonly current = this._current.asReadonly();
  readonly users = this._users.asReadonly();
  readonly isAdmin = computed(() => this._current()?.role === 'admin');

  /**
   * Whether someone is logged in, asking the backend if this service does not
   * know yet. A project with a single passwordless account is logged in by
   * the backend as it opens, so for those this is true without any UI.
   */
  async ensureSession(): Promise<boolean> {
    if (!this._current()) this._current.set(await api.currentUser());
    return this._current() !== null;
  }

  async refreshUsers(): Promise<void> {
    this._users.set(await api.listUsers());
  }

  /** Log in as `userId`, replacing whoever was. Rejects on a wrong password. */
  async login(userId: number, password: string | null = null): Promise<void> {
    await this.flush();
    const user = await api.login(userId, password);
    await this.adopt(user);
  }

  /** Create an editor account and log in as it. */
  async register(name: string, password: string | null): Promise<void> {
    await this.flush();
    const user = await api.registerUser(name, password);
    await api.login(user.id, password);
    await this.adopt(user);
  }

  async logout(): Promise<void> {
    await this.flush();
    await api.logout();
    await this.adopt(null);
  }

  async update(userId: number, change: UserChange): Promise<void> {
    const user = await api.updateUser(userId, change);
    if (this._current()?.id === user.id) this._current.set(user);
    await this.refreshUsers();
  }

  footprint(userId: number): Promise<UserFootprint> {
    return api.userFootprint(userId);
  }

  async remove(userId: number): Promise<void> {
    await api.deleteUser(userId);
    await this.refreshUsers();
  }

  /** @see ProjectScoped */
  resetForProject(): void {
    this._current.set(null);
    this._users.set([]);
  }

  private async flush(): Promise<void> {
    if (!(await this.io.saveIfDirty())) {
      throw new Error(
        'The frame open in the editor could not be saved, so the account was not changed.',
      );
    }
  }

  /** Point the frontend at `user`'s data. The backend already is. */
  private async adopt(user: UserInfo | null): Promise<void> {
    // Clears this service too, which is why `_current` is set afterwards.
    this.lifecycle.resetAll();
    await this.labels.setDefinitions(this.project.config());
    this._current.set(user);
    await this.refreshUsers();
  }
}
