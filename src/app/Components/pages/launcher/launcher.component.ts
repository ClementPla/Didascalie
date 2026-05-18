// launcher.component.ts

import { Component, OnInit, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { open } from '@tauri-apps/plugin-dialog';

import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';

import { ProjectService, RecentProject } from '../../../Services/ProjectService/project.service';

@Component({
  selector: 'app-launcher',
  standalone: true,
  imports: [CommonModule, ButtonModule, ToastModule],
  providers: [MessageService],
  templateUrl: './launcher.component.html',
  styleUrl: './launcher.component.scss',
})
export class LauncherComponent implements OnInit {
  readonly recentProjects = signal<RecentProject[]>([]);
  readonly isLoading = signal(false);

  constructor(
    private projectService: ProjectService,
    private router: Router,
    private messageService: MessageService,
  ) {}

  ngOnInit(): void {
    this.recentProjects.set(this.projectService.getRecentProjects());
  }

  newProject(): void {
    this.router.navigate(['/new']);
  }

  async openFromDisk(): Promise<void> {
    const path = await open({
      filters: [{ name: 'LabelMed Project', extensions: ['labelmed'] }],
    });
    if (!path) return;
    await this.openPath(path as string);
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
    const d = typeof iso === 'string' || typeof iso === 'number' ? new Date(iso) : iso;
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} days ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)} weeks ago`;
    return d.toLocaleDateString();
  }
}