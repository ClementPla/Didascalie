import { Routes } from '@angular/router';
import { GalleryComponent } from './features/gallery/gallery.component';
import { projectStartedGuard } from './guards/project-started.guard';
import { EditorComponent } from './features/editor/editor.component';
import { ExportComponent } from './features/export/export.component';
import { LauncherComponent } from './features/launcher/launcher.component';
import { NewProjectComponent } from './features/launcher/new-project/new-project.component';
import { RegistrationComponent } from './features/registration/components/registration.component';
export const routes: Routes = [
  { path: '', component: LauncherComponent },
  { path: 'new', component: NewProjectComponent },
  {
    path: 'gallery',
    component: GalleryComponent,
    canActivate: [projectStartedGuard],
  },
  {
    path: 'editor',
    component: EditorComponent,
    canActivate: [projectStartedGuard],
  },
  {
    path: 'export',
    component: ExportComponent,
    canActivate: [projectStartedGuard],
  },
  {
    path: 'registration',
    component: RegistrationComponent,
    canActivate: [projectStartedGuard],
  },
  {
    // Lazy-loaded: the lab is a side quest, and keeping it out of the initial
    // bundle avoids charging every session for it.
    path: 'model-lab',
    loadComponent: () =>
      import('./features/model-lab/model-lab.component').then(
        (m) => m.ModelLabComponent,
      ),
    canActivate: [projectStartedGuard],
  },
  {
    path: 'inspect',
    loadComponent: () =>
      import('./features/inspect/inspect.component').then(
        (m) => m.InspectComponent,
      ),
    canActivate: [projectStartedGuard],
  },
  {
    path: 'composite-registration-viewport-popout',
    loadComponent: () =>
      import('./features/registration/components/popout-composite-viewport/popout-composite-viewport.component').then(
        (m) => m.CompositePopoutComponent,
      ),
  },
];
