import { Routes } from '@angular/router';
import { GalleryComponent } from './Components/pages/gallery/gallery.component';
import { projectStartedGuard } from './Guards/project-started.guard';
import { EditorComponent } from './Components/pages/editor/editor.component';
import { ExportComponent } from './Components/pages/export/export.component';
import { LauncherComponent } from './Components/pages/launcher/launcher.component';
import { NewProjectComponent } from './Components/pages/launcher/new-project/new-project.component';
import { RegistrationComponent } from './Components/pages/registration/components/registration.component';
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
    path: 'composite-registration-viewport-popout',
    loadComponent: () =>
      import('./Components/pages/registration/components/popout-composite-viewport/popout-composite-viewport.component').then(
        (m) => m.CompositePopoutComponent,
      ),
  },
];
