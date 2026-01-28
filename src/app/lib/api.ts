import { invoke } from '@tauri-apps/api/core';
export interface Sequence {
  id: number;
  name: string;
  frame_count: number;
  sort_order: number;
}

export interface Frame {
  id: number;
  sequence_id: number;
  frame_index: number;
  relative_path: string | null;
  width: number;
  height: number;
  reviewed: boolean;
  is_embedded: boolean;
}

export interface FrameImage {
  frame: Frame;
  image_base64: string; // data URL: "data:image/png;base64,..."
}

export interface AnnotationResponse {
  labelId: number;
  labelName: string;
  color: string;
  maskPngBase64: string;
  width: number;
  height: number;
}

export interface AnnotationSave {
  label_id: number;
  mask_data: number[];
  width: number;
  height: number;
}

export interface TaskDefinitions {
  segmentation_labels: Array<{
    name: string;
    color: string;
    is_instance: boolean;
  }>;
  classification_tasks: Array<{
    name: string;
    classes: string[];
    multi_select: boolean;
  }>;
  text_description_tasks: Array<{
    name: string;
  }>;
}
export interface LabelConfig {
  id: number;
  name: string;
  color: string;
  shades?: string[]; // For instance segmentation
}

export interface MulticlassConfig {
  name: string;
  classes: string[];
  default?: string;
}

export interface MultilabelConfig {
  name: string;
  classes: string[];
  default?: string[];
}

export interface ProjectConfig {
  name: string;
  input_folder: string | null;
  images_embedded: boolean;
  embed_threshold_kb: number;
  segmentation_enabled: boolean;
  classification_enabled: boolean;
  instance_segmentation_enabled: boolean;
  text_description_enabled: boolean;
  input_regex: string;
  recursive: boolean;
  folders_as_sequences: boolean;
  // Labels
  segmentation_labels?: LabelConfig[];
  classification_tasks?: MulticlassConfig[];
  multilabel_task?: MultilabelConfig;
  text_fields?: string[];
}

export interface ScanResult {
  sequences_created: number;
  frames_created: number;
}

export interface ClassificationData {
  taskName: string;
  taskIndex: number;
  selectedClasses: string[];
  isMultilabel: boolean;
}

export interface TextDescriptionData {
  fieldName: string;
  content: string;
}

export interface BatchClassificationPayload {
  frame_id: number; // snake_case to match Rust
  task_name: string;
  selected_classes: string[];
  is_multilabel: boolean;
}

export interface LabelId {
  id: number;
  name: string;
}

export interface LabelInfo {
  id: number;
  name: string;
  color: string;
  isInstance: boolean;
  sortOrder: number;
}

export interface ExportOptions {
  output_folder: string;
  individual_mask: boolean;
  combined_mask: boolean;
  colormap: boolean;
  only_reviewed: boolean;
  instance_segmentation: boolean;
  classifications: boolean;
}

export interface ExportResult {
  total_exported: number;
  errors: string[];
}

export interface GallerySequence {
  id: number;
  name: string;
  sort_order: number;
  frame_count: number;
  reviewed_count: number;
  first_frame_id: number | null;
}


export const api = {
  getLabels: () => invoke<LabelInfo[]>('get_labels'),

  async getGallerySequences(): Promise<GallerySequence[]> {
    return invoke<GallerySequence[]>('get_gallery_sequences');
  },

  async getAllFrameIdsBySequence(): Promise<Record<number, number[]>> {
    return invoke<Record<number, number[]>>('get_all_frame_ids_by_sequence');
  },

  getSequenceFrames: (sequenceId: number) =>
    invoke<Frame[]>('get_sequence_frames', {
      sequenceId: sequenceId,
    }),

  listSequences: () => invoke<Sequence[]>('list_sequences'),

  getFrameImage: (frameId: number) =>
    invoke<FrameImage>('get_frame_image', {
      frameId: frameId,
    }),
  getFrameThumbnail: (frameId: number, maxSize: number) =>
    invoke<{ image_base64: string }>('get_frame_thumbnail', {
      frameId: frameId,
      maxSize: maxSize,
    }),

  getProgress: () => invoke<[number, number]>('get_progress'),

  loadAnnotations: (frameId: number) =>
    invoke<AnnotationResponse[]>('load_annotations', { frameId }),

  saveAnnotation: (
    frameId: number,
    labelId: number,
    maskData: Uint8Array,
    encoding: 'Rle' | 'Png',
  ) => {
    const payload = {
      frameId,
      labelId,
      maskData: Array.from(maskData),
      encoding,
    };
    return invoke<void>('save_annotation', payload);
  },

  saveTaskDefinitions: (definitions: TaskDefinitions) =>
    invoke('save_task_definitions', {
      definitions: definitions,
    }),

  getTaskDefinitions: () => invoke<TaskDefinitions>('get_task_definitions'),

  createProject: (projectName: string, path: string, config: ProjectConfig) =>
    invoke('create_project', {
      projectName: projectName,
      path: path,
      config: config,
    }),
  openProject: (path: string) =>
    invoke<ProjectConfig>('open_project', { path }),

  closeProject: () => invoke('close_project'),

  scanAndImportFolder: (options: {
    folder_path: string;
    embed_images: boolean;
    embed_threshold_kb: number;
    input_regex: string;
    recursive: boolean;
    folders_as_sequences: boolean;
  }) => invoke<ScanResult>('scan_and_import_folder', { options: options }),

  setFrameReviewed: (frameId: number, reviewed: boolean) =>
    invoke('set_frame_reviewed', {
      frameId: frameId,
      reviewed: reviewed,
    }),

  getFramesCount: () => invoke<number>('get_frames_count'),
  getSequencesCount: () => invoke<number>('get_sequences_count'),
  // Single frame
  loadClassification: (frameId: number) =>
    invoke<ClassificationData[]>('load_classification', { frameId }),

  saveClassification: (
    frameId: number,
    taskName: string,
    selectedClasses: string[],
    isMultilabel: boolean,
  ) =>
    invoke<void>('save_classification', {
      frameId,
      taskName,
      selectedClasses,
      isMultilabel,
    }),

  loadTextDescriptions: (frameId: number) =>
    invoke<TextDescriptionData[]>('load_text_descriptions', { frameId }),

  saveTextDescription: (frameId: number, fieldName: string, content: string) =>
    invoke<void>('save_text_description', { frameId, fieldName, content }),
  deleteTextDescription: (frameId: number, fieldName: string) =>
    invoke<void>('delete_text_description', { frameId, fieldName }),

  // Batch operations
  saveBatchClassifications: (classifications: BatchClassificationPayload[]) =>
    invoke<void>('save_batch_classifications', { classifications }),

  setFramesReviewed: (frameIds: number[], reviewed: boolean) =>
    invoke<void>('set_frames_reviewed', { frameIds, reviewed }),

  listLabels: () => invoke<LabelId[]>('list_labels'),

  exportAnnotations: (options: ExportOptions) =>
    invoke<ExportResult>('export_annotations', { options }),
};
