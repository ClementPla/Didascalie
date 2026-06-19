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
import { UIStateService } from './Services/uistate.service';
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
    FpsDisplayComponent
],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent implements OnInit, OnDestroy {
  title = 'LabelMed';

  constructor(
    public uiStateService: UIStateService,
    public editorService: EditorService,
    private appInitialization: AppInitializationService,
    private themeService: ThemeService,
    public projectService: ProjectService
  ) {
    this.themeService.init();
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
    console.log('AppComponent destroyed and resources cleaned up.');
    
  }

  public isProjectStarted(): boolean {
    return this.projectService.isOpen();
  }
}