import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ToolbarModule } from 'primeng/toolbar';
import { LoadingComponent } from './features/loading/loading.component';
import { RouterOutlet, RouterModule } from '@angular/router';
import { EditorService } from './features/editor/services/editor.service';
import { AppInitializationService } from './services/app-initialization.service';
import { ThemeService } from './services/theme.service';
import { Button } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { BlockUIModule } from 'primeng/blockui';
import { DividerModule } from 'primeng/divider';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { Subject, takeUntil } from 'rxjs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { UIStateService } from './services/uistate.service';
import { NotificationService } from './services/notification.service';
import { IOService } from './services/io.service';
import { FpsDisplayComponent } from "./shared/fps-display/fps-display.component";
import { ProjectService } from './services/project/project.service';
import { UpdateService } from './services/update.service';
import { UserService } from './services/users/user.service';
import { ExperimentalSettingsComponent } from './experimental/experimental-settings/experimental-settings.component';
import { ConnectionSettingsComponent } from './shared/connection-settings/connection-settings.component';
@Component({
  selector: 'app-root',
  imports: [
    ToolbarModule,
    LoadingComponent,
    RouterOutlet,
    Button,
    TooltipModule,
    RouterModule,
    BlockUIModule,
    DividerModule,
    ToastModule,
    FpsDisplayComponent,
    ExperimentalSettingsComponent,
    ConnectionSettingsComponent,
],
  providers: [MessageService],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  uiStateService = inject(UIStateService);
  editorService = inject(EditorService);
  notificationService = inject(NotificationService);
  private appInitialization = inject(AppInitializationService);
  private themeService = inject(ThemeService);
  private messageService = inject(MessageService);
  private ioService = inject(IOService);
  projectService = inject(ProjectService);
  updateService = inject(UpdateService);
  userService = inject(UserService);

  title = 'Didascalie';

  /** Published user documentation. Kept here rather than in a template literal
   *  so the one place to change it is obvious. */
  private static readonly DOCS_URL = 'https://didascalie.readthedocs.io/';

  /** Open the documentation in the user's browser, not in a webview. */
  async openDocumentation(): Promise<void> {
    try {
      await openUrl(AppComponent.DOCS_URL);
    } catch (error) {
      console.error('[app] could not open the documentation', error);
    }
  }

  private readonly destroy$ = new Subject<void>();
  private unlistenClose: (() => void) | null = null;

  constructor() {
    this.themeService.init();
  }

  async ngOnInit(): Promise<void> {
    // Render app-wide notifications through a single global toast.
    this.notificationService.toast$
      .pipe(takeUntil(this.destroy$))
      .subscribe((n) =>
        this.messageService.add({
          severity: n.severity,
          summary: n.summary,
          detail: n.detail,
          life: n.life ?? (n.severity === 'error' ? 8000 : 4000),
        }),
      );

    await this.setupCloseGuard();

    try {
      await this.appInitialization.initialize();
    } catch (error) {
      console.error('Application initialization failed:', error);
      const detail = error instanceof Error ? error.message : String(error);
      this.notificationService.setCriticalError(
        `The application failed to start: ${detail}`,
      );
    }
  }

  /**
   * Persist unsaved annotations before the window actually closes, so quitting
   * never silently discards work. No-op outside Tauri (e.g. browser dev).
   */
  private async setupCloseGuard(): Promise<void> {
    try {
      const appWindow = getCurrentWindow();
      this.unlistenClose = await appWindow.onCloseRequested(async (event) => {
        if (!this.ioService.isDirty()) return;
        event.preventDefault();
        try {
          await this.ioService.saveIfDirty();
        } catch (error) {
          console.error('Failed to save before closing:', error);
        }
        await appWindow.destroy();
      });
    } catch {
      // Not running under Tauri — nothing to guard.
    }
  }

  ngOnDestroy(): void {
    this.unlistenClose?.();
    this.destroy$.next();
    this.destroy$.complete();
    this.appInitialization.cleanup();
  }

  public reload(): void {
    window.location.reload();
  }

  public isProjectStarted(): boolean {
    return this.projectService.isOpen();
  }

  /** A project is open and someone is logged in: the working pages have
   *  annotations to show. Until then only the account picker is reachable. */
  public canWork(): boolean {
    return this.projectService.isOpen() && this.userService.current() !== null;
  }
}