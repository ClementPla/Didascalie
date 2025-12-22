// batch-annotation.service.ts
import { Injectable } from '@angular/core';
import { ClassificationService } from './classification.service';
import { IOService } from '../io.service';
export interface BatchAnnotationResult {
  success: boolean;
  processedCount: number;
  failedCount: number;
  errors: string[];
}

/**
 * Handles batch annotation operations across multiple images.
 */
@Injectable({
  providedIn: 'root',
})
export class BatchAnnotationService {
  constructor(
    private classificationService: ClassificationService,
    private ioService: IOService
  ) {}

  /**
   * Apply classification choices to multiple images.
   */
  public async applyBatchClassifications(
    imageNames: string[],
    choices: Array<string | null>
  ): Promise<BatchAnnotationResult> {
    const result: BatchAnnotationResult = {
      success: true,
      processedCount: 0,
      failedCount: 0,
      errors: [],
    };

    // Validate inputs
    if (imageNames.length === 0) {
      result.success = false;
      result.errors.push('No images provided');
      return result;
    }

    if (choices.length === 0) {
      result.success = false;
      result.errors.push('No classification choices provided');
      return result;
    }

    // Apply to each image
    for (const imageName of imageNames) {
      try {
        this.classificationService.setMulticlassChoicesForImage(
          imageName,
          choices
        );
        result.processedCount++;
      } catch (error) {
        result.failedCount++;
        result.errors.push(`Failed to annotate ${imageName}: ${error}`);
        console.error(`Batch annotation failed for ${imageName}:`, error);
      }
    }

    // Save to disk
    try {
      await this.ioService.saveClassification();
    } catch (error) {
      result.success = false;
      result.errors.push(`Failed to save classifications: ${error}`);
      throw error;
    }

    result.success = result.failedCount === 0;
    return result;
  }
}
