import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// Angular's ErrorHandler does not catch bare rejected promises.
window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled rejection]', event.reason);
});

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
