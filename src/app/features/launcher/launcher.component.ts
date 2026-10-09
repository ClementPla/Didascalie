import { Component, OnInit, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { open } from '@tauri-apps/plugin-dialog';

import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { MessageService } from 'primeng/api';

import {
  ProjectService,
  RecentProject,
} from '../../services/project/project.service';
import { ThemeService } from '../../services/theme.service';
import { UpdateService } from '../../services/update.service';
import { IS_ANDROID } from '../../core/platform';
import { api } from '../../lib/api';
import { LabelledSwitchComponent } from '../../shared/generics/labelled-switch/labelled-switch.component';
import { ImportDialogComponent } from './import-dialog/import-dialog.component';

@Component({
  selector: 'app-launcher',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    ToastModule,
    SelectModule,
    LabelledSwitchComponent,
    ImportDialogComponent,
  ],
  providers: [MessageService],
  templateUrl: './launcher.component.html',
  styleUrl: './launcher.component.scss',
})
export class LauncherComponent implements OnInit {
  readonly isAndroid = IS_ANDROID;
  private projectService = inject(ProjectService);
  private router = inject(Router);
  private messageService = inject(MessageService);
  theme = inject(ThemeService);
  update = inject(UpdateService);

  readonly recentProjects = signal<RecentProject[]>([]);
  readonly isLoading = signal(false);
  showImportDialog = false;

  ngOnInit(): void {
    this.recentProjects.set(this.projectService.getRecentProjects());
    // The tablet build is updated by installing a new one.
    if (IS_ANDROID) return;
    // Offer an app update on the first screen if one is available.
    void this.update.checkForUpdates();
  }

  newProject(): void {
    this.router.navigate(['/new']);
  }

  /**
   * Manually check the release channel. If an update is found the banner
   * appears (via `update.available()`); otherwise confirm we're up to date.
   */
  async checkForUpdates(): Promise<void> {
    await this.update.checkForUpdates();
    if (!this.update.available()) {
      const version = this.update.currentVersion();
      this.messageService.add({
        severity: 'success',
        summary: 'Up to date',
        detail: version
          ? `You're running the latest version (v${version}).`
          : "You're running the latest version.",
      });
    }
  }

  openImportDialog(): void {
    this.showImportDialog = true;
  }

  async openFromDisk(): Promise<void> {
    const path = await open({
      filters: [
        { name: 'Didascalie Project', extensions: ['dida', 'labelmed'] },
      ],
    });
    if (!path) return;
    await this.openPath(path as string);
  }

  /**
   * Android: pick a project from the device and import it. What the picker
   * returns is a `content://` URI, not a path SQLite could open, so the file
   * is copied into the application's storage and the copy is what opens.
   */
  async openFromDevice(): Promise<void> {
    // No extension filter: Android filters by MIME type and has none for .dida.
    const location = await open({ multiple: false });
    if (!location) return;
    this.isLoading.set(true);
    try {
      await this.openPath(await api.importProjectFile(location as string));
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Could not open project',
        detail: String(error),
      });
    } finally {
      this.isLoading.set(false);
    }
  }

  async openRecent(project: RecentProject): Promise<void> {
    await this.openPath(project.path);
  }

  removeRecent(event: MouseEvent, project: RecentProject): void {
    event.stopPropagation();
    this.projectService.removeFromRecentProjects(project.path);
    this.recentProjects.set(this.projectService.getRecentProjects());
  }

  private async openPath(path: string): Promise<void> {
    this.isLoading.set(true);
    try {
      await this.projectService.open(path);
      this.router.navigate(['/gallery']);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Could not open project',
        detail: String(error),
      });
      // Stale entry; remove it.
      this.projectService.removeFromRecentProjects(path);
      this.recentProjects.set(this.projectService.getRecentProjects());
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Format a path for display: trim to a readable length, keep the meaningful
   * tail (the filename and its parent directory).
   */
  formatPath(path: string): string {
    const max = 60;
    if (path.length <= max) return path;
    // Keep the last 60 chars, prefix with ellipsis at the front.
    return '…' + path.slice(-(max - 1));
  }

  /** Friendly relative time. Avoids a date library for one place. */
  relativeTime(iso: string | number | Date): string {
    const d =
      typeof iso === 'string' || typeof iso === 'number' ? new Date(iso) : iso;
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} days ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)} weeks ago`;
    return d.toLocaleDateString();
  }
}
