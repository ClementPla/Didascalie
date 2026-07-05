import { ApplicationConfig, ErrorHandler } from '@angular/core';
import { provideRouter } from '@angular/router';
import '@angular/compiler';

import { RouterModule } from '@angular/router';
import { routes } from './app.routes';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MessageService } from 'primeng/api';

import { GlobalErrorHandler } from './Services/global-error-handler';

RouterModule.forRoot(routes);

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimationsAsync(),
    MessageService,
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
  ],
};
