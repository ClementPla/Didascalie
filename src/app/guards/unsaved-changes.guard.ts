import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { ask } from '@tauri-apps/plugin-dialog';
import { IOService } from '../services/io.service';

/** Ask whether to go on although the annotations could not be saved. */
export async function confirmDiscardUnsaved(action: string): Promise<boolean> {
  const message = `The annotations of this frame could not be saved. ${action} anyway and lose the unsaved changes?`;
  try {
    return await ask(message, { title: 'Unsaved changes', kind: 'warning' });
  } catch {
    // Not running under Tauri.
    return window.confirm(message);
  }
}

/** Leaving the editor saves the open frame; if that fails, the user decides. */
export const saveBeforeLeavingGuard: CanDeactivateFn<unknown> = async () => {
  const io = inject(IOService);
  if (await io.saveIfDirty()) return true;
  if (!(await confirmDiscardUnsaved('Leave'))) return false;
  io.discardPendingSave();
  return true;
};
