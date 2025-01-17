import { ProjectConfig } from "./interface";
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';


export async function saveProjectConfigFile(root: string, projectConfig: ProjectConfig) {
  const projectConfigPath = path.join(
    root,
    'project_config.json'
  );
  // Convert the projectConfig object to a JSON string

  const projectConfigString = JSON.stringify(projectConfig, null, 2);

  return invokeSaveJsonFile(await projectConfigPath, projectConfigString);

}
export function invokeSaveXmlFile(filepath: string, xmlContent: string) {
  try {
    invoke('save_xml_file', { filepath, xmlContent }).then((response) => {
      console.log('XML file saved successfully');
    });
  } catch (error) {
    console.error('Error saving XML file:', error);
  }
}

export function invokeSaveJsonFile(filepath: string, jsonContent: string) {
  try {
    // 
    invoke('save_json_file', { filepath, jsonContent }).then((response) => {
      console.log('JSON file saved successfully');
    });
  } catch (error) {
    console.error('Error saving JSON file:', error);
  }
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
  return invoke<ArrayBuffer>('load_image_as_base64', { filepath: filepath })
    .then((value) => {
      return new Promise<string>((resolve, reject) => {
        const blob = new Blob([value], { type: 'image/png' });
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result as string);
        };
        reader.onerror = (error) => {
          reject(error);
        };
        reader.readAsDataURL(blob);
      });
    });
}