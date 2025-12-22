// app.component.ts
import { Component, OnInit, OnDestroy } from '@angular/core';
import { ToolbarModule } from 'primeng/toolbar';
import { LoadingComponent } from './Components/pages/loading/loading.component';
import { RouterOutlet, RouterModule } from '@angular/router';
import { ProjectService } from './Services/ProjectService/project.service';
import { EditorService } from './Components/pages/editor/services/editor.service';
import { AppInitializationService } from './Services/app-initialization.service';
import { PrimeNG } from 'primeng/config';
import Aura from '@primeng/themes/aura';
import { Button } from 'primeng/button';
import { BlockUIModule } from 'primeng/blockui';
import { DividerModule } from 'primeng/divider';
import { UIStateService } from './Services/uistate.service';
import { FpsDisplayComponent } from "./Components/Utils/fps-display/fps-display.component";
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
    FpsDisplayComponent
],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'LabelMed';

  constructor(
    public uiStateService: UIStateService,
    public projectService: ProjectService,
    public editorService: EditorService,
    private appInitialization: AppInitializationService,
    private primeNG: PrimeNG
  ) {
    this.configureTheme();
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.appInitialization.initialize();
    } catch (error) {
      console.error('Application initialization failed:', error);
      // TODO: Show critical error screen
    }
  }

  ngOnDestroy(): void {
    this.appInitialization.cleanup();
  }

  private configureTheme(): void {
    this.primeNG.theme.set({
      preset: Aura,
      options: {
        darkModeSelector: '.darkTheme',
        cssLayer: {
          name: 'primeng',
          order: 'tailwind-base, primeng, tailwind-utilities',
        },
      },
    });
  }

  public isProjectStarted(): boolean {
    return this.projectService.isProjectStarted;
  }
}