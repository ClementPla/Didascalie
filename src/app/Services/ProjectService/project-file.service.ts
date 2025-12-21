import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { path } from '@tauri-apps/api';
import { resolve } from '@tauri-apps/api/path';

const ANNOTATIONS_FOLDER = 'annotations';
const LOCAL_FOLDER = 'local';
const CONFIG_FILENAME = 'project_config.json';

/**
 * Handles file system operations for projects.
 * Lists files, resolves paths, and manages file naming.
 */
@Injectable({
  providedIn: 'root',
})
export class ProjectFileService {

  // ==========================================
  // File Listing
  // ==========================================

  /**
   * Lists files in a folder matching a regex pattern.
   */
  async listFiles(
    folder: string,
    regexFilter: string,
    recursive: boolean = true
  ): Promise<string[]> {
    try {
      return await invoke<string[]>('list_files_in_folder', {
        folder,
        regexfilter: regexFilter,
        recursive,
      });
    } catch (error) {
      console.error('Failed to list files:', error);
      return [];
    }
  }

  /**
   * Lists annotation files in a project's local annotations folder.
   */
  async listAnnotations(projectFolder: string): Promise<string[]> {
    const annotationsPath = await path.join(
      projectFolder,
      ANNOTATIONS_FOLDER,
      LOCAL_FOLDER
    );

    try {
      const fileList = await this.listFiles(annotationsPath, '.*.svg$', true);
      const separator = await path.sep();
      
      return fileList.map((file) => {
        const relativePath = file.split(annotationsPath + separator)[1];
        return relativePath ?? file;
      });
    } catch (error) {
      console.error('Failed to list annotations:', error);
      return [];
    }
  }

  // ==========================================
  // Path Operations
  // ==========================================

  /**
   * Resolves and normalizes a path, ensuring it ends with a separator.
   */
  async normalizeInputPath(inputPath: string): Promise<string> {
    let resolved = await resolve(inputPath);
    const separator = await path.sep();

    if (!resolved.endsWith(separator)) {
      resolved += separator;
    }

    return resolved;
  }

  /**
   * Resolves a path without adding trailing separator.
   */
  async resolvePath(inputPath: string): Promise<string> {
    return resolve(inputPath);
  }

  /**
   * Joins path segments.
   */
  async joinPaths(...segments: string[]): Promise<string> {
    return path.join(...segments);
  }

  /**
   * Gets the path separator for the current platform.
   */
  async getPathSeparator(): Promise<string> {
    return path.sep();
  }

  /**
   * Extracts the directory containing a config file and resolves relative paths.
   */
  async resolveRelativePath(basePath: string, relativePath: string): Promise<string> {
    if (!relativePath.startsWith('.')) {
      return relativePath; // Already absolute
    }

    const joined = await path.join(basePath, relativePath);
    return resolve(joined);
  }

  /**
   * Gets the directory containing a config file.
   */
  getConfigDirectory(configFilePath: string): string {
    return configFilePath.split(CONFIG_FILENAME)[0];
  }

  // ==========================================
  // Name Extraction
  // ==========================================

  /**
   * Extracts relative image names from full file paths.
   * @param files - Full file paths
   * @param inputFolder - Base input folder to strip from paths
   */
  extractRelativeNames(files: string[], inputFolder: string): string[] {
    return files.map((file) => {
      const relativePath = file.split(inputFolder)[1];

      if (relativePath) {
        // Normalize path separators to forward slashes
        return relativePath.replace(/\\/g, '/');
      }

      // Fallback to full path if input folder not found
      return file;
    });
  }

  /**
   * Extracts the filename without extension.
   */
  getNameWithoutExtension(filename: string): string {
    return filename.split('.').slice(0, -1).join('.');
  }

  /**
   * Replaces the extension of a filename.
   */
  replaceExtension(filename: string, newExtension: string): string {
    const nameWithoutExt = this.getNameWithoutExtension(filename);
    return nameWithoutExt + newExtension;
  }

  /**
   * Gets the filename from a full path.
   */
  async getFilename(filePath: string): Promise<string> {
    return path.basename(filePath);
  }

  /**
   * Gets the directory from a full path.
   */
  async getDirectory(filePath: string): Promise<string> {
    return path.dirname(filePath);
  }

  // ==========================================
  // Project Paths
  // ==========================================

  /**
   * Builds the project folder path.
   */
  async getProjectFolder(outputFolder: string, projectName: string): Promise<string> {
    return path.join(outputFolder, projectName);
  }

  /**
   * Builds the path to an annotation file.
   */
  async getAnnotationPath(
    projectFolder: string,
    imageName: string
  ): Promise<string> {
    const svgName = this.replaceExtension(imageName, '.svg');
    return path.join(projectFolder, ANNOTATIONS_FOLDER, LOCAL_FOLDER, svgName);
  }

  /**
   * Builds the path to the classification CSV file.
   */
  async getClassificationPath(projectFolder: string): Promise<string> {
    return path.join(projectFolder, ANNOTATIONS_FOLDER, 'classification.csv');
  }
}