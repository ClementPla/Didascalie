import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { DialogModule } from 'primeng/dialog';
import { FieldsetModule } from 'primeng/fieldset';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';

import { Role, UserInfo } from '../../lib/api';
import { NotificationService } from '../../services/notification.service';
import { ProjectService } from '../../services/project/project.service';
import { UserService } from '../../services/users/user.service';

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** An account deletion waiting for confirmation. */
interface PendingDelete {
  user: UserInfo;
  /** One sentence per kind of work that will be erased; empty if none. */
  consequences: string[];
}

/**
 * Accounts: pick who is annotating, register, and manage accounts. Before
 * anyone is logged in the page is the account picker; once logged in,
 * accounts are also renamed, protected, promoted or deleted here.
 */
@Component({
  selector: 'app-users',
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    CheckboxModule,
    DialogModule,
    FieldsetModule,
    InputTextModule,
    SelectModule,
    TagModule,
    TooltipModule,
  ],
  templateUrl: './users.component.html',
  styleUrl: './users.component.scss',
})
export class UsersComponent implements OnInit {
  readonly users = inject(UserService);
  readonly project = inject(ProjectService);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);

  readonly list = this.users.users;
  readonly current = this.users.current;
  readonly busy = signal(false);

  // ── Signing in ────────────────────────────────────────────────────────────

  readonly asking = signal<number | null>(null);
  password = '';
  readonly loginError = signal<string | null>(null);

  // ── Registering ───────────────────────────────────────────────────────────

  newName = '';
  newPassword = '';

  // ── Managing ──────────────────────────────────────────────────────────────

  readonly roleOptions: { label: string; value: Role }[] = [
    { label: 'Administrator', value: 'admin' },
    { label: 'Editor', value: 'editor' },
  ];

  /** The account whose password is being set, if any. */
  readonly settingPassword = signal<UserInfo | null>(null);
  passwordDraft = '';

  readonly pendingDelete = signal<PendingDelete | null>(null);
  acknowledged = false;

  /** Deleting needs the tick only when there is work to lose. */
  readonly canConfirmDelete = computed(
    () => (this.pendingDelete()?.consequences.length ?? 0) === 0,
  );

  async ngOnInit(): Promise<void> {
    try {
      await this.users.ensureSession();
      await this.users.refreshUsers();
    } catch (error) {
      this.notifications.error('Could not load the accounts', this.message(error));
    }
  }

  initial(user: UserInfo): string {
    return user.name.trim().charAt(0).toUpperCase() || '?';
  }

  isCurrent(user: UserInfo): boolean {
    return this.current()?.id === user.id;
  }

  /** Whether the logged-in user may rename `user` and set its password. */
  canEdit(user: UserInfo): boolean {
    return this.users.isAdmin() || this.isCurrent(user);
  }

  // ── Signing in ───────────────────────────────────────────────────────────

  choose(user: UserInfo): void {
    this.loginError.set(null);
    if (this.isCurrent(user)) {
      void this.router.navigate(['/gallery']);
    } else if (user.hasPassword) {
      this.password = '';
      this.asking.set(user.id);
    } else {
      void this.signIn(user, null);
    }
  }

  async signIn(user: UserInfo, password: string | null): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.users.login(user.id, password);
      this.asking.set(null);
      await this.router.navigate(['/gallery']);
    } catch (error) {
      this.loginError.set(this.message(error));
    } finally {
      this.busy.set(false);
    }
  }

  async register(): Promise<void> {
    const name = this.newName.trim();
    if (!name || this.busy()) return;
    this.busy.set(true);
    try {
      await this.users.register(name, this.newPassword || null);
      this.newName = '';
      this.newPassword = '';
      await this.router.navigate(['/gallery']);
    } catch (error) {
      this.notifications.error('Could not create the account', this.message(error));
    } finally {
      this.busy.set(false);
    }
  }

  async signOut(): Promise<void> {
    await this.attempt('Could not sign out', () => this.users.logout());
  }

  // ── Managing ─────────────────────────────────────────────────────────────

  async rename(user: UserInfo, input: HTMLInputElement): Promise<void> {
    const name = input.value.trim();
    if (name !== user.name) {
      await this.attempt('Could not rename the account', () =>
        this.users.update(user.id, { type: 'rename', name }),
      );
    }
    input.value = this.list().find((u) => u.id === user.id)?.name ?? user.name;
  }

  async setRole(user: UserInfo, role: Role): Promise<void> {
    if (role === user.role) return;
    await this.attempt('Could not change the role', () =>
      this.users.update(user.id, { type: 'setRole', role }),
    );
  }

  openPassword(user: UserInfo): void {
    this.passwordDraft = '';
    this.settingPassword.set(user);
  }

  async savePassword(password: string | null): Promise<void> {
    const user = this.settingPassword();
    if (!user) return;
    this.settingPassword.set(null);
    await this.attempt('Could not change the password', () =>
      this.users.update(user.id, { type: 'setPassword', password }),
    );
  }

  async askDelete(user: UserInfo): Promise<void> {
    try {
      const f = await this.users.footprint(user.id);
      this.acknowledged = false;
      this.pendingDelete.set({
        user,
        consequences: [
          f.annotatedFrames > 0 &&
            `Their masks and shapes on ${plural(f.annotatedFrames, 'frame')}.`,
          f.classifiedFrames > 0 &&
            `Their classification answers on ${plural(f.classifiedFrames, 'frame')}.`,
          f.textFrames > 0 && `Their text on ${plural(f.textFrames, 'frame')}.`,
          f.reviewedFrames > 0 &&
            `Their review of ${plural(f.reviewedFrames, 'frame')}.`,
        ].filter((line): line is string => !!line),
      });
    } catch (error) {
      this.notifications.error('Could not delete the account', this.message(error));
    }
  }

  async confirmDelete(): Promise<void> {
    const pending = this.pendingDelete();
    if (!pending) return;
    this.pendingDelete.set(null);
    await this.attempt('Could not delete the account', () =>
      this.users.remove(pending.user.id),
    );
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async attempt(failure: string, action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.notifications.error(failure, this.message(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Tauri rejects with the backend's message as a plain string. */
  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
