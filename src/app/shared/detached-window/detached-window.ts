import { api } from '../../lib/api';

/**
 * Show a piece of the UI in its own OS window.
 *
 * `detachElement` opens a blank popup (answered natively by
 * `create_main_window` in `src-tauri/src/lib.rs`) and moves the element's DOM
 * into it. The element stays in the main window's Angular app and JavaScript
 * context, and goes back in place when the popup closes.
 *
 * In another document, the element must:
 * - use `ownerWindow(element)` for `window`, `document`,
 *   `requestAnimationFrame` and `ResizeObserver` (see `frameScheduler`,
 *   `observeSize`);
 * - append overlays (PrimeNG popovers, menus, tooltips) to itself, not to
 *   `document.body`.
 */

export interface DetachOptions {
  /** Window title, unique among detached windows: the native window is found
   *  by it. */
  title: string;
  width: number;
  height: number;
  /** Called after the element is back in the main window. */
  onReturn: () => void;
}

export interface DetachedWindow {
  readonly window: Window;
  /** Put the element back and close the window. */
  close(): void;
}

/** The window whose document holds `node`. */
export function ownerWindow(node: Node): Window {
  return node.ownerDocument?.defaultView ?? window;
}

/** Move `element` into a new window until it closes. Null when the popup
 *  could not be opened. */
export function detachElement(element: HTMLElement, options: DetachOptions): DetachedWindow | null {
  const parent = element.parentNode;
  if (!parent) return null;
  const popup = window.open('about:blank', '', `popup,width=${options.width},height=${options.height}`);
  if (!popup) return null;

  const doc = popup.document;
  doc.title = options.title;
  mirrorDocumentShell(doc);
  const stopMirroring = mirrorStyles(doc);
  const stopForwarding = forwardKeys(popup);

  // A placeholder keeps the element's place.
  const placeholder = document.createComment('detached view');
  parent.insertBefore(placeholder, element);
  doc.body.appendChild(element);

  let returned = false;
  const restore = () => {
    if (returned) return;
    returned = true;
    clearInterval(closedPoll);
    stopMirroring();
    stopForwarding();
    placeholder.parentNode?.insertBefore(element, placeholder);
    placeholder.remove();
    options.onReturn();
  };
  popup.addEventListener('pagehide', restore);
  // A natively closed window does not always fire pagehide.
  const closedPoll = setInterval(() => {
    if (popup.closed) restore();
  }, 400);

  return {
    window: popup,
    close: () => {
      restore();
      // The popup is a native window: script can't close it, the backend can.
      if (!popup.closed) {
        popup.close();
        void api.closeDetachedWindow(options.title).catch((error) =>
          console.error('Could not close the detached window:', error),
        );
      }
    },
  };
}

/** Theme classes and base layout of the main document. */
function mirrorDocumentShell(doc: Document): void {
  for (const { name, value } of Array.from(document.documentElement.attributes)) {
    doc.documentElement.setAttribute(name, value);
  }
  doc.body.className = document.body.className;
  doc.body.style.cssText =
    'margin:0;height:100vh;display:flex;overflow:hidden;user-select:none;-webkit-user-select:none;background:var(--p-content-background)';
}

/** Copy the main document's stylesheets, and keep copying: Angular and
 *  PrimeNG add `<style>` elements as components first render. */
function mirrorStyles(doc: Document): () => void {
  const copy = (node: Node) => {
    if (node instanceof HTMLStyleElement) {
      doc.head.appendChild(node.cloneNode(true));
    } else if (node instanceof HTMLLinkElement && node.rel === 'stylesheet') {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = node.href; // absolute: the popup has no base URL of its own
      doc.head.appendChild(link);
    }
  };
  document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach(copy);
  const observer = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach(copy);
  });
  observer.observe(document.head, { childList: true });
  return () => observer.disconnect();
}

/** Shortcuts (undo, save, ...) listen on the main window: pass keys on. */
function forwardKeys(popup: Window): () => void {
  const forward = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) {
      return;
    }
    const copy = new KeyboardEvent(event.type, {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      repeat: event.repeat,
      cancelable: true,
    });
    window.dispatchEvent(copy);
    if (copy.defaultPrevented) event.preventDefault();
  };
  popup.addEventListener('keydown', forward);
  popup.addEventListener('keyup', forward);
  return () => {
    popup.removeEventListener('keydown', forward);
    popup.removeEventListener('keyup', forward);
  };
}

/** Schedule work on the next animation frame of the window showing
 *  `element`. */
export function frameScheduler(element: () => Element | null | undefined): (callback: () => void) => void {
  return (callback) => {
    const el = element();
    (el ? ownerWindow(el) : window).requestAnimationFrame(() => callback());
  };
}

/** Observe `element`'s size with the ResizeObserver of its window. Returns a
 *  function that stops observing. */
export function observeSize(element: Element, callback: (width: number, height: number) => void): () => void {
  const Observer = (ownerWindow(element) as Window & typeof globalThis).ResizeObserver ?? ResizeObserver;
  const observer = new Observer(([entry]) => {
    callback(entry.contentRect.width, entry.contentRect.height);
  });
  observer.observe(element);
  return () => observer.disconnect();
}
