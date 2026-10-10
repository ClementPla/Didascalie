import { signal } from '@angular/core';

/** Whether the app runs in the Android build (a tablet: touch, one window). */
export const IS_ANDROID = /Android/i.test(navigator.userAgent);

if (IS_ANDROID) document.documentElement.classList.add('is-android');

const narrowPortrait = window.matchMedia(
  '(orientation: portrait) and (max-width: 1000px)',
);
const narrowPortraitSignal = signal(narrowPortrait.matches);
narrowPortrait.addEventListener('change', (e) =>
  narrowPortraitSignal.set(e.matches),
);

/**
 * A screen taller than wide and too narrow for side panels: a tablet held
 * upright. The editor then moves its labels into a bar above the canvas.
 */
export const NARROW_PORTRAIT = narrowPortraitSignal.asReadonly();
