import { Injectable } from '@angular/core';
import { api } from '../../lib/api';
import { ClassificationService } from './classification.service';
import { LabelsService } from './labels.service';

export interface BatchAnnotationResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  errors: string[];
}

export interface BatchClassificationPayload {
  frame_id: number;
  task_name: string;
  selected_classes: string[];
  is_multilabel: boolean;
}

@Injectable({
  providedIn: 'root',
})
export class BatchAnnotationService {
  constructor(
    private classificationService: ClassificationService,
    private labelsService: LabelsService,
  ) {}

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

    // Build batch payload
    const payload: BatchClassificationPayload[] = [];
    for (const frameId of frameIds) {
      for (let i = 0; i < tasks.length; i++) {
        const value = choices[i];
        if (value !== null) {
          payload.push({
            frame_id: frameId,
            task_name: tasks[i].taskName,
            selected_classes: [value],
            is_multilabel: false,
          });
        }
      }
    }
    console.log(payload);

    // Save to database
    try {
      await api.saveBatchClassifications(payload);

      // Update in-memory cache
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
      frame_id: frameId,
      task_name: multilabelTask.taskName,
      selected_classes: values,
      is_multilabel: true,
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