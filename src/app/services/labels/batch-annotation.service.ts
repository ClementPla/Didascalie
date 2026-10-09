import { Injectable, inject } from '@angular/core';
import { api, BatchClassificationPayload } from '../../lib/api';
import { ClassificationService } from './classification.service';
import { LabelsService } from './labels.service';

export interface BatchAnnotationResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  errors: string[];
}

/** Re-exported so existing importers of this service keep resolving it. */
export type { BatchClassificationPayload };

@Injectable({
  providedIn: 'root',
})
export class BatchAnnotationService {
  private classificationService = inject(ClassificationService);
  private labelsService = inject(LabelsService);

  /**
   * Apply multiclass classification choices to multiple frames.
   */
  public async applyBatchMulticlassToFrames(
    frameIds: number[],
    choices: (string | null)[]
  ): Promise<BatchAnnotationResult> {
    const result: BatchAnnotationResult = {
      success: true,
      processedCount: 0,
      failedCount: 0,
      errors: [],
    };

    if (frameIds.length === 0) {
      result.success = false;
      result.errors.push('No frames provided');
      return result;
    }

    const tasks = this.labelsService.listClassificationTasks;
    if (choices.length !== tasks.length) {
      result.success = false;
      result.errors.push('Choice count does not match task count');
      return result;
    }

    const payload: BatchClassificationPayload[] = [];
    for (const frameId of frameIds) {
      for (let i = 0; i < tasks.length; i++) {
        const value = choices[i];
        if (value !== null) {
          payload.push({
            frameId: frameId,
            taskName: tasks[i].taskName,
            selectedClasses: [value],
            isMultilabel: false,
          });
        }
      }
    }

    try {
      await api.saveBatchClassifications(payload);

      for (const frameId of frameIds) {
        this.classificationService.setMulticlassChoices(frameId, choices);
      }

      result.processedCount = frameIds.length;
    } catch (error) {
      result.success = false;
      result.failedCount = frameIds.length;
      result.errors.push(`Failed to save classifications: ${error}`);
      console.error('Failed to save batch classifications:', error);
    }

    return result;
  }

  /**
   * Apply multilabel choices to multiple frames.
   */
  public async applyBatchMultilabelToFrames(
    frameIds: number[],
    values: string[]
  ): Promise<BatchAnnotationResult> {
    const result: BatchAnnotationResult = {
      success: true,
      processedCount: 0,
      failedCount: 0,
      errors: [],
    };

    const multilabelTask = this.labelsService.multiLabelTask;
    if (!multilabelTask) {
      result.success = false;
      result.errors.push('No multilabel task defined');
      return result;
    }

    const payload: BatchClassificationPayload[] = frameIds.map(frameId => ({
      frameId: frameId,
      taskName: multilabelTask.taskName,
      selectedClasses: values,
      isMultilabel: true,
    }));

    try {
      await api.saveBatchClassifications(payload);

      for (const frameId of frameIds) {
        this.classificationService.setMultilabelChoices(frameId, values);
      }

      result.processedCount = frameIds.length;
    } catch (error) {
      result.success = false;
      result.failedCount = frameIds.length;
      result.errors.push(`Failed to save multilabel: ${error}`);
      console.error('Failed to save batch multilabel:', error);
    }

    return result;
  }

  /**
   * Mark multiple frames as reviewed.
   */
  public async markFramesReviewed(
    frameIds: number[],
    reviewed = true
  ): Promise<BatchAnnotationResult> {
    const result: BatchAnnotationResult = {
      success: true,
      processedCount: 0,
      failedCount: 0,
      errors: [],
    };

    try {
      await api.setFramesReviewed(frameIds, reviewed);
      result.processedCount = frameIds.length;
    } catch (error) {
      result.success = false;
      result.failedCount = frameIds.length;
      result.errors.push(`Failed to mark frames as reviewed: ${error}`);
      console.error('Failed to mark frames as reviewed:', error);
    }

    return result;
  }
}