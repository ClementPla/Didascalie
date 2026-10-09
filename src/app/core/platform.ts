/** Whether the app runs in the Android build (a tablet: touch, one window). */
export const IS_ANDROID = /Android/i.test(navigator.userAgent);

if (IS_ANDROID) document.documentElement.classList.add('is-android');
