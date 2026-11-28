import { ApplicationConfig, ErrorHandler } from '@angular/core';
import { provideRouter } from '@angular/router';
import '@angular/compiler';

import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MessageService } from 'primeng/api';

import { routes } from './app.routes';
import { GlobalErrorHandler } from './services/global-error-handler';
import { provideProjectScoped } from './core/project-scoped.providers';

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimationsAsync(),
    MessageService,
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
    provideProjectScoped(),
  ],
};
