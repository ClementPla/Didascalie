import { ApplicationConfig, importProvidersFrom } from '@angular/core';
import { provideRouter } from '@angular/router';
import '@angular/compiler';

import { RouterModule } from '@angular/router';
import { routes } from './app.routes';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';

import { NgxOpenCVModule, OpenCVConfig } from 'ngx-opencv';

const openCVConfig: OpenCVConfig = {
  openCVDirPath: 'assets/opencv',
};

RouterModule.forRoot(routes);

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideAnimationsAsync(),
    importProvidersFrom(NgxOpenCVModule.forRoot(openCVConfig)),
  ],
};
