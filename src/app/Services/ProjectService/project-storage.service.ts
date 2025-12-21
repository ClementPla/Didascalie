import { Injectable } from '@angular/core';
import { ProjectFile } from '../../Core/interface';

const STORAGE_KEY_PROJECTS = 'projects';

/**
 * Manages localStorage operations for project files.
 * Handles the list of recently opened projects.
 */
@Injectable({
  providedIn: 'root',
})
export class ProjectStorageService {
  private _recentProjects: ProjectFile[] = [];

  constructor() {
    this.loadFromStorage();
  }

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Gets the list of recent projects.
   */
  get recentProjects(): readonly ProjectFile[] {
    return this._recentProjects;
  }

  /**
   * Adds a project to the recent projects list.
   * Skips if already present.
   */
  addProject(project: ProjectFile): void {
    const exists = this._recentProjects.some((p) => p.root === project.root);

    if (!exists) {
      this._recentProjects.push(project);
      this.saveToStorage();
    }
  }

  /**
   * Removes a project from the recent projects list.
   */
  removeProject(projectRoot: string): void {
    this._recentProjects = this._recentProjects.filter(
      (project) => project.root !== projectRoot
    );
    this.saveToStorage();
  }

  /**
   * Finds a project by its root path.
   */
  findByRoot(root: string): ProjectFile | undefined {
    return this._recentProjects.find((p) => p.root === root);
  }

  /**
   * Clears all recent projects.
   */
  clear(): void {
    this._recentProjects = [];
    this.saveToStorage();
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private loadFromStorage(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_PROJECTS);
      this._recentProjects = stored ? JSON.parse(stored) : [];
    } catch (error) {
      console.error('Failed to load projects from localStorage:', error);
      this._recentProjects = [];
    }
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY_PROJECTS,
        JSON.stringify(this._recentProjects)
      );
    } catch (error) {
      console.error('Failed to save projects to localStorage:', error);
    }
  }
}