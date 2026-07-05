import { invoke } from '@tauri-apps/api/core';

export function loadImageFile(filepath: string): Promise<string> {
  return invoke<string>('load_image_as_base64', { filepath });
}
