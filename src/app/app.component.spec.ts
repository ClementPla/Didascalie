import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { AppComponent } from './app.component';

/**
 * Smoke test for the app shell.
 *
 * This file used to be the untouched Angular scaffold: it asserted the title
 * was `'Client'` and that an `<h1>` read `Hello, Client`, neither of which was
 * ever true here, and it rendered the component without a router so the shell's
 * `<router-outlet>` threw on a missing `ActivatedRoute`. Two of its three cases
 * had therefore been failing for the whole life of the project, which is a good
 * part of why the suite went unrun.
 */
describe('AppComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      // The shell hosts a router-outlet, so it needs a router to render at all.
      providers: [provideRouter([])],
    }).compileComponents();
  });

  it('creates the shell', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('carries the application name', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance.title).toBe('Didascalie');
  });

  it('renders without throwing', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(() => fixture.detectChanges()).not.toThrow();
  });
});
