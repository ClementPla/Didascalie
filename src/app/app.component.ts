// app.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { ToolbarModule } from 'primeng/toolbar';
import { LoadingComponent } from './Components/pages/loading/loading.component';
import { RouterOutlet, RouterModule } from '@angular/router';
import { EditorService } from './Components/pages/editor/services/editor.service';
import { AppInitializationService } from './Services/app-initialization.service';
import { ThemeService } from './Services/theme.service';
import { Button } from 'primeng/button';
import { BlockUIModule } from 'primeng/blockui';
import { DividerModule } from 'primeng/divider';
import { ToastModule } from 'primeng/toast';
import { MessageService } from 'primeng/api';
import { Subject, takeUntil } from 'rxjs';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { UIStateService } from './Services/uistate.service';
import { NotificationService } from './Services/notification.service';
import { IOService } from './Services/io.service';
import { FpsDisplayComponent } from "./Components/Utils/fps-display/fps-display.component";
import { ProjectService } from './Services/ProjectService/project.service';
@Component({
  selector: 'app-root',
  imports: [
    ToolbarModule,
    LoadingComponent,
    RouterOutlet,
    Button,
    RouterModule,
    BlockUIModule,
    DividerModule,
    ToastModule,
    FpsDisplayComponent
],
  providers: [MessageService],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'Didascalie';

  private readonly destroy$ = new Subject<void>();
  private unlistenClose: (() => void) | null = null;

  constructor(
    public uiStateService: UIStateService,
    public editorService: EditorService,
    public notificationService: NotificationService,
    private appInitialization: AppInitializationService,
    private themeService: ThemeService,
    private messageService: MessageService,
    private ioService: IOService,
    public projectService: ProjectService
  ) {
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
          life: n.severity === 'error' ? 8000 : 4000,
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
}