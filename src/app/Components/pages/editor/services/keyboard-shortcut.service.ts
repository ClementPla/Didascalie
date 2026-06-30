// keyboard-shortcut.service.ts
import { Injectable, OnDestroy } from '@angular/core';
import { Subject, fromEvent } from 'rxjs';
import { filter, takeUntil } from 'rxjs/operators';

export interface ShortcutConfig {
  keys: string[];
  action: string;
  description: string;
  category: 'tools' | 'navigation' | 'view' | 'file' | 'edit';
}

@Injectable({
  providedIn: 'root'
})
export class KeyboardShortcutService implements OnDestroy {
  private destroy$ = new Subject<void>();
  private actions$ = new Subject<string>();
  public action$ = this.actions$.asObservable();

  // Modifier tracking for hold-to-activate shortcuts
  private heldModifiers = new Set<string>();
  private modifierRelease$ = new Subject<string>();
  public modifierReleased$ = this.modifierRelease$.asObservable();

  private shortcuts: ShortcutConfig[] = [
    // Tools
    { keys: ['1', 'p'], action: 'selectPen', description: 'Select pen tool', category: 'tools' },
    { keys: ['2', 'e'], action: 'selectEraser', description: 'Select eraser', category: 'tools' },
    { keys: ['3', 'shift+l'], action: 'selectLasso', description: 'Select lasso tool', category: 'tools' },
    { keys: ['4', 'ctrl+shift+e'], action: 'selectLassoEraser', description: 'Select lasso eraser', category: 'tools' },
    { keys: ['l'], action: 'selectLine', description: 'Select line tool', category: 'tools' },
    { keys: ['g'], action: 'selectPan', description: 'Select pan tool', category: 'tools' },
    { keys: ['b'], action: 'selectPath', description: 'Select path (bezier) tool', category: 'tools' },
    { keys: ['n'], action: 'selectNode', description: 'Select node (edit) tool', category: 'tools' },

    // Edit
    { keys: ['ctrl+z'], action: 'undo', description: 'Undo', category: 'edit' },
    { keys: ['ctrl+y'], action: 'redo', description: 'Redo', category: 'edit' },

    // View
    { keys: ['tab'], action: 'toggleAllVisibility', description: 'Toggle all labels visibility', category: 'view' },
    { keys: ['ctrl+tab'], action: 'nextLabel', description: 'Cycle to next label', category: 'view' },
    { keys: ['ctrl+e'], action: 'toggleEdges', description: 'Toggle edge display', category: 'view' },
    { keys: ['q'], action: 'toggleImageProcessing', description: 'Toggle image processing', category: 'view' },
    { keys: ['d'], action: 'togglePostProcessing', description: 'Toggle post-processing', category: 'view' },
    { keys: ['=', '+', 'shift++'], action: 'zoomIn', description: 'Zoom in', category: 'view' },
    { keys: ['-', '_', 'shift+_'], action: 'zoomOut', description: 'Zoom out', category: 'view' },

    // File / Navigation
    { keys: ['ctrl+s'], action: 'save', description: 'Save annotations', category: 'file' },
    { keys: ['arrowright'], action: 'nextImage', description: 'Next image', category: 'navigation' },
    { keys: ['arrowleft'], action: 'previousImage', description: 'Previous image', category: 'navigation' },
  ];

  // Keys that trigger hold-to-activate behavior
  private holdKeys = new Map<string, string>([
    [' ', 'panMode'],      // Space for pan
    ['alt', 'quickMenu'],  // Alt for quick access menu
  ]);

  constructor() {
    this.initKeydownListener();
    this.initKeyupListener();
    this.initBlurListener();
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  private initKeydownListener() {
    fromEvent<KeyboardEvent>(window, 'keydown')
      .pipe(
        filter(() => !this.isInputFocused()),
        takeUntil(this.destroy$)
      )
      .subscribe(event => {
        // Check hold keys first
        const holdAction = this.holdKeys.get(event.key.toLowerCase());
        if (holdAction && !this.heldModifiers.has(event.key.toLowerCase())) {
          this.heldModifiers.add(event.key.toLowerCase());
          this.actions$.next(`${holdAction}:start`);
          event.preventDefault();
          return;
        }

        // Match regular shortcuts
        const action = this.matchShortcut(event);
        if (action) {
          event.preventDefault();
          this.actions$.next(action);
        }
      });
  }

  private initKeyupListener() {
    fromEvent<KeyboardEvent>(window, 'keyup')
      .pipe(takeUntil(this.destroy$))
      .subscribe(event => {
        const key = event.key.toLowerCase();
        if (this.heldModifiers.has(key)) {
          this.heldModifiers.delete(key);
          const holdAction = this.holdKeys.get(key);
          if (holdAction) {
            this.actions$.next(`${holdAction}:end`);
          }
        }
      });
  }

  private initBlurListener() {
    fromEvent(window, 'blur')
      .pipe(takeUntil(this.destroy$))
      .subscribe(() => {
        // Release all held modifiers when window loses focus
        this.heldModifiers.forEach(key => {
          const holdAction = this.holdKeys.get(key);
          if (holdAction) {
            this.actions$.next(`${holdAction}:end`);
          }
        });
        this.heldModifiers.clear();
      });
  }

  private matchShortcut(event: KeyboardEvent): string | null {
    const normalizedKey = this.normalizeKey(event);
    
    for (const shortcut of this.shortcuts) {
      if (shortcut.keys.some(k => k.toLowerCase() === normalizedKey)) {
        return shortcut.action;
      }
    }
    return null;
  }

  private normalizeKey(event: KeyboardEvent): string {
    const parts: string[] = [];
    
    if (event.ctrlKey || event.metaKey) parts.push('ctrl');
    if (event.shiftKey) parts.push('shift');
    if (event.altKey) parts.push('alt');
    
    // Normalize key name
    let key = event.key.toLowerCase();
    if (key === ' ') key = 'space';
    
    parts.push(key);
    return parts.join('+');
  }

  private isInputFocused(): boolean {
    const activeElement = document.activeElement;
    if (!activeElement) return false;
    
    const tagName = activeElement.tagName.toUpperCase();
    const isEditable = activeElement.getAttribute('contenteditable') === 'true';
    
    return tagName === 'INPUT' || tagName === 'TEXTAREA' || isEditable;
  }

  /**
   * Get shortcuts for UI display (e.g., help dialog)
   */
  public getShortcutsByCategory(category: ShortcutConfig['category']): ShortcutConfig[] {
    return this.shortcuts.filter(s => s.category === category);
  }

  public getAllShortcuts(): ShortcutConfig[] {
    return [...this.shortcuts];
  }

  /**
   * Format shortcut key for display
   */
  public formatKeyForDisplay(key: string): string {
    return key
      .replace('ctrl', '⌘/Ctrl')
      .replace('shift', '⇧')
      .replace('alt', 'Alt')
      .replace('arrowright', '→')
      .replace('arrowleft', '←')
      .replace('+', ' + ')
      .toUpperCase();
  }
}