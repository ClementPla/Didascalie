import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';


import { NgxOpenCVModule, OpenCVConfig } from 'ngx-opencv';

const openCVConfig: OpenCVConfig = {
  openCVDirPath: 'assets/opencv/',
};




// Surface unhandled promise rejections (Angular's ErrorHandler only catches
// errors thrown inside the zone, not bare rejected promises).
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled rejection]', event.reason);
});

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
