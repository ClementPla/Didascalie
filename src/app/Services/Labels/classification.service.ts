// classification.service.ts
import { Injectable } from '@angular/core';
import { api } from '../../lib/api';

@Injectable({
  providedIn: 'root',
})
export class ClassificationService {
  // In-memory cache per frame
  private multiclassCache = new Map<number, Array<string | null>>();
  private multilabelCache = new Map<number, string[]>();

  async loadForFrame(frameId: number, taskCount: number): Promise<void> {
    const classifications = await api.loadClassification(frameId);

    // Initialize arrays
    this.multiclassCache.set(frameId, new Array(taskCount).fill(null));
    this.multilabelCache.set(frameId, []);

    for (const c of classifications) {
      if (c.isMultilabel) {
        this.multilabelCache.set(frameId, c.selectedClasses);
      } else {
        const choices = this.multiclassCache.get(frameId)!;
        choices[c.taskIndex] = c.selectedClasses[0] ?? null;
      }
    }
  }

  // Getters
  getMulticlassChoices(frameId: number): Array<string | null> {
    return this.multiclassCache.get(frameId) ?? [];
  }

  getMultilabelChoices(frameId: number): string[] {
    return this.multilabelCache.get(frameId) ?? [];
  }

  // Setters (in-memory only)
  setMulticlassChoice(frameId: number, taskIndex: number, value: string | null): void {
    const choices = this.multiclassCache.get(frameId);
    if (choices) {
      choices[taskIndex] = value;
    }
  }

  setMulticlassChoices(frameId: number, choices: Array<string | null>): void {
    this.multiclassCache.set(frameId, [...choices]);
  }

  setMultilabelChoices(frameId: number, values: string[]): void {
    this.multilabelCache.set(frameId, [...values]);
  }

  // Persistence
  async saveMulticlass(frameId: number, taskName: string, value: string | null): Promise<void> {
    await api.saveClassification(frameId, taskName, value ? [value] : [], false);
  }

  async saveMultilabel(frameId: number, taskName: string, values: string[]): Promise<void> {
    await api.saveClassification(frameId, taskName, values, true);
  }

  clear(): void {
    this.multiclassCache.clear();
    this.multilabelCache.clear();
  }
}