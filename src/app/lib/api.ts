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
  /** Base64 of the raw uint8 value mask (0 = bg, 1 = semantic, id = instance). */
  maskBase64: string;
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
  /** Emit per-frame vector JSON (exact nodes + flattened polygon). */
  vectors: boolean;
  /** Bake vector shapes into the exported masks. */
  rasterize_vectors: boolean;
}

export interface ExportResult {
  total_exported: number;
  errors: string[];
}

// ── Pluggable dataset formats (COCO, YOLO, NIfTI, …) ──────────────────────────

export interface FormatChoice {
  value: string;
  label: string;
}

/** A single self-describing option a format exposes to the UI. */
export type FormatOption =
  | { type: 'bool'; key: string; label: string; default: boolean }
  | { type: 'enum'; key: string; label: string; choices: FormatChoice[]; default: string }
  | { type: 'int'; key: string; label: string; default: number; min: number; max: number };

export interface DatasetFormat {
  id: string;
  name: string;
  description: string;
  canExport: boolean;
  canImport: boolean;
  exportOptions: FormatOption[];
  importOptions: FormatOption[];
  capabilities: {
    masks: boolean;
    polygons: boolean;
    bboxes: boolean;
    classifications: boolean;
    instances: boolean;
  };
}

export interface ImportResult {
  framesMatched: number;
  framesUnmatched: number;
  annotationsImported: number;
  labelsCreated: number;
  errors: string[];
}

export interface GallerySequence {
  id: number;
  name: string;
  sort_order: number;
  frame_count: number;
  reviewed_count: number;
  annotated_count: number;
  first_frame_id: number | null;
  has_keypoints: boolean;
}
export type KeypointSource = 'user' | 'prefilled';
export interface KeypointPair {
  clientUuid: string;
  refX: number;
  refY: number;
  movingX: number;
  movingY: number;
  source?: KeypointSource;
}

export interface RegistrationData {
  referenceFrameId: number;
  movingFrameId: number;
  /** 9 floats for a 3x3 homography (row-major), or null if no fit yet. */
  homography:
    | [number, number, number, number, number, number, number, number, number]
    | null;
  transformType: 'homography' | 'tps' | 'bspline-grid';
  pairs: KeypointPair[];
}

/** Summary of one registration case (frame pair) within a sequence. */
export interface RegistrationSummary {
  referenceFrameId: number;
  movingFrameId: number;
  transformType: string;
  hasHomography: boolean;
  pairCount: number;
}

interface PingReply {
  ok: boolean;
  protocol_version: number;
  registered: string[];
}

type WirePair = [[number, number], [number, number]];

// ── Vector annotations ──────────────────────────────────────────────────────
// A single vector primitive (bezier path / polygon / open polyline). Handles
// are stored as absolute image-space coordinates; a straight segment is a node
// whose handles equal its anchor.
export interface VectorNode {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  /** Keep the two handles collinear when edited (smooth) vs. independent (cusp). */
  smooth: boolean;
}

export interface VectorShape {
  id: string;
  labelId: number;
  closed: boolean;
  /** Only meaningful when `closed`. */
  filled: boolean;
  nodes: VectorNode[];
}

/** All shapes for one (frame, label), as returned by the backend. */
export interface VectorAnnotationsWire {
  label_id: number;
  shapes: VectorShape[];
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
  /** Display image downsampled server-side to `maxDim`; `frame.width/height`
   *  stay native. For images too large for the browser to decode directly. */
  getFrameOverview: (frameId: number, maxDim: number) =>
    invoke<FrameImage>('get_frame_overview', { frameId, maxDim }),
  getFrameThumbnail: (frameId: number, maxSize: number) =>
    invoke<{ image_base64: string }>('get_frame_thumbnail', {
      frameId: frameId,
      maxSize: maxSize,
    }),

  getProgress: () => invoke<[number, number]>('get_progress'),

  loadAnnotations: (frameId: number) =>
    invoke<AnnotationResponse[]>('load_annotations', { frameId }),

  saveAnnotation: (frameId: number, labelId: number, maskData: Uint8Array) => {
    // Send the mask as raw bytes (Rust receives Vec<u8>) instead of a JSON
    // number array — the latter is pathologically slow/large for big masks.
    // `.slice().buffer` passes a detached-safe copy so the live label mask is
    // never at risk if the IPC layer were to transfer (neuter) the buffer.
    return invoke<void>('save_annotation', {
      frameId,
      labelId,
      maskData: maskData.slice().buffer,
    });
  },

  /** Load every vector shape on a frame, grouped by owning label. */
  loadVectorAnnotations: (frameId: number) =>
    invoke<VectorAnnotationsWire[]>('load_vector_annotations', { frameId }),

  /** Replace all vector shapes for one (frame, label). Empty array clears them. */
  saveVectorAnnotations: (
    frameId: number,
    labelId: number,
    shapes: VectorShape[],
  ) => invoke<void>('save_vector_annotations', { frameId, labelId, shapes }),

  /**
   * Trace the connected component of a label mask under pixel (x, y) into
   * simplified outer-contour polygons (image-pixel coords). Empty when the
   * clicked pixel is background.
   */
  vectorizeComponent: (
    mask: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
  ) =>
    invoke<number[][][]>('vectorize_component', {
      mask: mask.slice().buffer,
      width,
      height,
      x,
      y,
    }),

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

  /** Metadata + option schema for every import/export format. */
  listDatasetFormats: () => invoke<DatasetFormat[]>('list_dataset_formats'),

  /** Export the open project in a chosen format. */
  exportDataset: (
    formatId: string,
    outputFolder: string,
    onlyReviewed: boolean,
    options: Record<string, unknown>,
  ) =>
    invoke<ExportResult>('export_dataset', {
      formatId,
      outputFolder,
      onlyReviewed,
      options,
    }),

  /** Import annotations into the open project (matched by filename). */
  importDataset: (formatId: string, path: string, options: Record<string, unknown>) =>
    invoke<ImportResult>('import_dataset', { formatId, path, options }),
  saveRegistration(sequenceId: number, data: RegistrationData): Promise<void> {
    return invoke('save_registration', { sequenceId, data });
  },

  loadRegistration(
    referenceFrameId: number,
    movingFrameId: number,
  ): Promise<RegistrationData | null> {
    return invoke('load_registration', { referenceFrameId, movingFrameId });
  },

  /** Every registration case (frame pair) stored for a sequence. */
  listRegistrations(sequenceId: number): Promise<RegistrationSummary[]> {
    return invoke('list_registrations', { sequenceId });
  },

  deleteRegistration(
    referenceFrameId: number,
    movingFrameId: number,
  ): Promise<void> {
    return invoke('delete_registration', { referenceFrameId, movingFrameId });
  },

  inferenceConnect: (host: string, port: number) =>
    invoke<PingReply>('inference_connect', { host, port }),

  findKeypointsPrefill: (
    name: string,
    refFrameId: number,
    movFrameId: number,
    existing: KeypointPair[],
  ): Promise<WirePair[]> => {
    const wire: WirePair[] = existing
      .filter((p) => p.source !== 'prefilled') // don't feed model its own output
      .map(
        (p) =>
          [
            [p.refX, p.refY],
            [p.movingX, p.movingY],
          ] as WirePair,
      );
    return invoke<WirePair[]>('find_keypoints_prefill', {
      name,
      refFrameId,
      movFrameId,
      existing: wire,
    });
  },
};
