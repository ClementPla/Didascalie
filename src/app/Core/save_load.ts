import { ProjectConfig } from './interface';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';

export async function saveProjectConfigFile(
  root: string,
  projectConfig: ProjectConfig
) {
  const projectConfigPath = path.join(root, 'project_config.json');
  // Convert the projectConfig object to a JSON string

  const projectConfigString = JSON.stringify(projectConfig, null, 2);

  invokeSaveJsonFile(await projectConfigPath, projectConfigString);
}
export async function invokeSaveXmlFile(filepath: string, xmlContent: string) {
  await invoke('save_xml_file', { filepath, xmlContent });
}
export async function invokeSaveCSVFile(filepath: string, csvContent: string) {
  await invoke('save_csv_file', { filepath, csvContent });
}

export async function invokeLoadCsvFile(filepath: string): Promise<string> {
  return invoke('load_csv_file', { filepath });
}

export async function invokeSaveJsonFile(
  filepath: string,
  jsonContent: string
) {
  //
  await invoke('save_json_file', { filepath, jsonContent });
}

export function invokeLoadJsonFile(filepath: string) {
  return invoke('load_json_file', { filepath });
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export function loadImageFile(filepath: string): Promise<string> {
  return invoke<string>('load_image_as_base64', { filepath });
}
