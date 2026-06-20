import { ApplicationConfig, ErrorHandler, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import '@angular/compiler';

import { RouterModule } from '@angular/router';
import { routes } from './app.routes';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MessageService } from 'primeng/api';

import { NgxOpenCVModule, OpenCVConfig } from 'ngx-opencv';
import { GlobalErrorHandler } from './Services/global-error-handler';

const openCVConfig: OpenCVConfig = {
  openCVDirPath: 'assets/opencv',
};

RouterModule.forRoot(routes);

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimationsAsync(),
    importProvidersFrom(NgxOpenCVModule.forRoot(openCVConfig)),
    MessageService,
    { provide: ErrorHandler, useClass: GlobalErrorHandler },
  ],
};
