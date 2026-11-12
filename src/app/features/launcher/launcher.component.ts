import { Component, OnInit, computed, signal, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';

import { ButtonModule } from 'primeng/button';
import { ToastModule } from 'primeng/toast';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { IconFieldModule } from 'primeng/iconfield';
import { InputIconModule } from 'primeng/inputicon';
import { MenuModule } from 'primeng/menu';
import { TooltipModule } from 'primeng/tooltip';
import { MenuItem, MessageService } from 'primeng/api';

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

const PROJECT_FILTERS = [
  { name: 'Didascalie Project', extensions: ['dida', 'labelmed'] },
];

@Component({
  selector: 'app-launcher',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    ButtonModule,
    ToastModule,
    SelectModule,
    InputTextModule,
    IconFieldModule,
    InputIconModule,
    MenuModule,
    TooltipModule,
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
  /** Paths of recent projects not found on this computer. */
  readonly missing = signal<ReadonlySet<string>>(new Set());
  readonly query = signal('');
  readonly isLoading = signal(false);
  showImportDialog = false;

  /** Recent projects matching the search, by name or path. */
  private readonly matching = computed(() => {
    const query = this.query().trim().toLowerCase();
    const projects = this.recentProjects();
    if (!query) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.path.toLowerCase().includes(query),
    );
  });
  readonly pinned = computed(() => this.matching().filter((p) => p.pinned));
  readonly unpinned = computed(() => this.matching().filter((p) => !p.pinned));

  /** Actions of the row whose menu is open. */
  rowMenuItems: MenuItem[] = [];

  ngOnInit(): void {
    this.reloadRecent();
    // The tablet build is updated by installing a new one.
    if (IS_ANDROID) return;
    void this.update.checkForUpdates();
  }

  private reloadRecent(): void {
    this.recentProjects.set(this.projectService.getRecentProjects());
    void this.checkMissing();
  }

  /** Grey out the projects whose file is not reachable (a drive unplugged, a
   *  share not mounted). They stay listed. */
  private async checkMissing(): Promise<void> {
    const paths = this.recentProjects().map((p) => p.path);
    if (paths.length === 0) return;
    try {
      const exists = await api.pathsExist(paths);
      this.missing.set(new Set(paths.filter((_, i) => !exists[i])));
    } catch (error) {
      console.error('[launcher] could not check the recent projects', error);
    }
  }

  isMissing(project: RecentProject): boolean {
    return this.missing().has(project.path);
  }

  newProject(): void {
    this.router.navigate(['/new']);
  }

  /** The licences of what ships with the application, the GPL microscopy
   *  reader's source among them. */
  async openLicences(): Promise<void> {
    try {
      await openUrl(LauncherComponent.LICENCES_URL);
    } catch (error) {
      console.error('[launcher] could not open the licences', error);
      this.messageService.add({
        severity: 'error',
        summary: 'Could not open the licences',
        detail: String(error),
      });
    }
  }

  private static readonly LICENCES_URL =
    'https://github.com/ClementPla/Didascalie/blob/release/THIRD_PARTY_NOTICES.md';

  /** Check the release channel, and say so when already up to date. */
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
    const path = await open({ filters: PROJECT_FILTERS });
    if (!path) return;
    await this.openPath(path as string);
  }

  /** Android: pick a project from the device. The picker returns a
   *  `content://` URI, so the file is copied into the application's storage. */
  async openFromDevice(): Promise<void> {
    // No extension filter: Android filters by MIME type, and .dida has none.
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
    if (this.isLoading()) return;
    if (this.isMissing(project)) {
      await this.locate(project);
      return;
    }
    await this.openPath(project.path);
  }

  /** Ask where a moved project now is; its entry follows it, then it opens. */
  async locate(project: RecentProject): Promise<void> {
    const picked = await open({
      filters: PROJECT_FILTERS,
      title: `Locate ${project.name}`,
    });
    if (typeof picked !== 'string' || !picked) return;
    this.projectService.relocateRecentProject(project.path, picked);
    this.reloadRecent();
    await this.openPath(picked);
  }

  togglePin(event: Event, project: RecentProject): void {
    event.stopPropagation();
    this.projectService.setRecentPinned(project.path, !project.pinned);
    this.reloadRecent();
  }

  remove(project: RecentProject): void {
    this.projectService.removeFromRecentProjects(project.path);
    this.reloadRecent();
  }

  /** Open the actions menu of one row. */
  openRowMenu(
    event: Event,
    menu: { toggle: (event: Event) => void },
    project: RecentProject,
  ): void {
    event.stopPropagation();
    const missing = this.isMissing(project);
    this.rowMenuItems = [
      ...(missing
        ? [
            {
              label: 'Locate…',
              icon: 'pi pi-search',
              command: () => void this.locate(project),
            },
          ]
        : []),
      ...(this.isAndroid
        ? []
        : [
            {
              label: 'Show in folder',
              icon: 'pi pi-folder',
              disabled: missing,
              command: () => void this.reveal(project),
            },
            {
              label: 'Copy path',
              icon: 'pi pi-copy',
              command: () => void this.copyPath(project),
            },
          ]),
      { separator: true },
      {
        label: 'Remove from list',
        icon: 'pi pi-times',
        command: () => this.remove(project),
      },
    ];
    menu.toggle(event);
  }

  private async reveal(project: RecentProject): Promise<void> {
    try {
      await revealItemInDir(project.path);
    } catch (error) {
      this.messageService.add({
        severity: 'error',
        summary: 'Could not show the file',
        detail: String(error),
      });
    }
  }

  private async copyPath(project: RecentProject): Promise<void> {
    try {
      await navigator.clipboard.writeText(project.path);
      this.messageService.add({
        severity: 'success',
        summary: 'Path copied',
        life: 1500,
      });
    } catch (error) {
      console.error('[launcher] could not copy the path', error);
    }
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
      // Kept in the list: the file may be on a drive not plugged in. It is
      // greyed out when it cannot be found.
      this.reloadRecent();
    } finally {
      this.isLoading.set(false);
    }
  }

  /** Share of frames reviewed, 0..100; null when unknown. */
  reviewedPercent(project: RecentProject): number | null {
    const stats = project.stats;
    if (!stats || stats.frames === 0) return null;
    return Math.round((100 * stats.reviewedFrames) / stats.frames);
  }

  /** "12 sequences · 340 frames"; empty when unknown. */
  describeCounts(project: RecentProject): string {
    const stats = project.stats;
    if (!stats) return '';
    const plural = (n: number, word: string) =>
      `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
    return `${plural(stats.sequences, 'sequence')} · ${plural(stats.frames, 'frame')}`;
  }

  /** The folder holding the project, shortened to its tail. */
  formatPath(path: string): string {
    const max = 70;
    if (path.length <= max) return path;
    return '…' + path.slice(-(max - 1));
  }

  relativeTime(iso: string | number | Date): string {
    const d =
      typeof iso === 'string' || typeof iso === 'number' ? new Date(iso) : iso;
    if (d.getTime() === 0) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} days ago`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)} weeks ago`;
    return d.toLocaleDateString();
  }
}
