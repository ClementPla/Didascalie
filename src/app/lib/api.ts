import { invoke } from '@tauri-apps/api/core';
export interface Sequence {
  id: number;
  name: string;
  frameCount: number;
  sortOrder: number;
}

export interface Frame {
  id: number;
  sequenceId: number;
  frameIndex: number;
  relativePath: string | null;
  width: number;
  height: number;
  reviewed: boolean;
  isEmbedded: boolean;
}

export interface FrameImage {
  frame: Frame;
  imageBase64: string; // data URL: "data:image/png;base64,..."
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

export interface LabelConfig {
  id: number;
  name: string;
  color: string;
  /** Per-instance shades, for instance-segmentation labels. */
  shades?: string[];
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
  sequencesCreated: number;
  framesImported: number;
  framesEmbedded: number;
  errors: string[];
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
  frameId: number; // snake_case to match Rust
  taskName: string;
  selectedClasses: string[];
  isMultilabel: boolean;
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

export interface ExportResult {
  totalExported: number;
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
  sortOrder: number;
  frameCount: number;
  reviewedCount: number;
  annotatedCount: number;
  firstFrameId: number | null;
  hasKeypoints: boolean;
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
  labelId: number;
  shapes: VectorShape[];
}

/** How propagated annotations combine with the target's existing ones. */
export type PropagationMode = 'replace';

export type PropagationSkipReason = 'sizeMismatch' | 'notFound';

export interface PropagationReport {
  /** Frames actually written. */
  applied: number[];
  skipped: { frameId: number; reason: PropagationSkipReason }[];
}

// ── Segmentation-head lab ────────────────────────────────────────────────────

/** A downloadable frozen encoder, plus whether its weights are on disk. */
export interface EncoderStatus {
  id: string;
  name: string;
  description: string;
  repoId: string;
  filename: string;
  patch: number;
  embedDim: number;
  inputSize: number;
  approxMb: number;
  domain: string;
  cached: boolean;
}

export interface DatasetSummary {
  /** Frames training will use: annotated **and** reviewed. */
  annotatedFrames: number;
  /** Annotated but not reviewed, and therefore excluded from training. */
  unreviewedFrames: number;
  labels: number;
  /** Labels plus background. */
  classes: number;
}

export interface EvalMetrics {
  accuracy: number;
  /** Mean over classes present in the reference; absent classes are excluded. */
  meanDice: number;
  perClassDice: number[];
}

export interface TrainOptions {
  /** Omit for the local feature basis alone — the encoder ablation. */
  encoderId?: string | null;
  workingSize?: number;
  patchesPerFrame?: number;
  cacheFeatures?: boolean;
  labelIds?: number[];
  augmentRepeats?: number;
  epochs?: number;
  hidden?: number;
  valFraction?: number;
  seed?: number;
}

/** Payload of the `ml-progress` event (feature extraction phase). */
export interface MlProgress {
  stage: string;
  done: number;
  total: number;
  /** Milliseconds for the most recent frame. */
  lastMs: number;
  etaMs: number;
}

/**
 * Payload of `ml-train-progress`, emitted once per epoch. Training dominates
 * wall-clock, so this is what keeps the UI honest during the slow phase.
 */
export interface TrainTick {
  budget: number;
  repeat: number;
  epoch: number;
  epochs: number;
  loss: number;
  /** Fit index within a sweep; both 0 for a single training run. */
  point: number;
  points: number;
  /** Wall-clock of the epoch just finished. */
  epochMs: number;
  elapsedMs: number;
  /** Projected time left across the whole job, not just this fit. */
  etaMs: number;
  /** Where optimisation actually runs — surfaced so CPU is never implicit. */
  device: string;
  samples: number;
  features: number;
}

export interface StorageUsage {
  featureBytes: number;
  featureFiles: number;
  modelBytes: number;
  cacheDir: string;
}

export interface TrainSummary {
  trainFrames: number;
  valFrames: number;
  featureDim: number;
  classes: number;
  encoder: string | null;
  metrics: EvalMetrics;
  /** Backend the head was fitted on, e.g. `CUDA (GPU)` or `CPU (burn ndarray)`. */
  device: string;
}

export interface PredictedMask {
  labelId: number;
  /** Base64 uint8 mask at native resolution, 1 where predicted. */
  maskBase64: string;
  coverage: number;
}

export interface PredictedFrame {
  frameId: number;
  width: number;
  height: number;
  masks: PredictedMask[];
}

/** Scribble conditioning: flat pixel indices at native resolution. */
export interface ScribbleInput {
  positive: number[];
  negative: number[];
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
  /** A native-resolution RGBA tile (row-major, `width*height*4` bytes) of a
   *  frame. Backs the tiled viewer for crisp detail on very large images. */
  getFrameTile: (
    frameId: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ) =>
    invoke<ArrayBuffer>('get_frame_tile', { frameId, x, y, width, height }),
  /**
   * Erase every annotation on every frame of a sequence, returning how many
   * frames carried one. Not undoable — it writes straight to the project.
   */
  clearSequenceAnnotations: (sequenceId: number) =>
    invoke<number>('clear_sequence_annotations', { sequenceId }),

  /** Every frame's pixels as 8-bit luminance, stacked in `frameIds` order
   *  (`W*H*D` bytes). Backs the 3D views; all frames must share one size. */
  loadSequenceImageVolume: (frameIds: number[]) =>
    invoke<ArrayBuffer>('load_sequence_image_volume', { frameIds }),
  /** One label's uint8 masks for every frame, stacked in `frameIds` order
   *  (`W*H*D` bytes); an unannotated frame is a zero slice. */
  loadLabelVolume: (frameIds: number[], labelId: number) =>
    invoke<ArrayBuffer>('load_label_volume', { frameIds, labelId }),

  /** Close the detached view window titled `title` (`window.close()` from
   *  the opener leaves these native windows open). */
  closeDetachedWindow: (title: string) =>
    invoke<void>('close_detached_window', { title }),

  getFrameThumbnail: (frameId: number, maxSize: number) =>
    invoke<FrameImage>('get_frame_thumbnail', { frameId, maxSize }),

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
   * Copy one frame's segmentation annotations (raster *and* vector, in one
   * transaction) onto other frames. `labelIds` restricts the copy; `null`
   * means every label. Runs entirely in SQLite — no mask crosses the IPC
   * boundary — and skips targets whose dimensions differ from the source's.
   */
  propagateAnnotations: (
    sourceFrameId: number,
    targetFrameIds: number[],
    labelIds: number[] | null,
    mode: PropagationMode = 'replace',
  ) =>
    invoke<PropagationReport>('propagate_annotations', {
      sourceFrameId,
      targetFrameIds,
      labelIds,
      mode,
    }),

  /**
   * Trace the connected component of a label mask under pixel (x, y) into
   * simplified outer-contour polygons (image-pixel coords). Empty when the
   * clicked pixel is background.
   */
  /**
   * Trace every component of a mask into simplified polygons. `minArea` drops
   * specks, which predicted masks carry and hand-drawn ones do not.
   */
  vectorizeMask: (
    mask: Uint8Array,
    width: number,
    height: number,
    minArea = 64,
    maxShapes = 64,
  ) =>
    invoke<number[][][]>('vectorize_mask', {
      mask: mask.slice().buffer,
      width,
      height,
      minArea,
      maxShapes,
    }),

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

  /**
   * Skeletonize the connected component under (x, y) into open centerline
   * polylines (image-pixel coords): the component is thinned to a 1px skeleton
   * and split at endpoints/junctions. Empty when the pixel is background.
   */
  skeletonizeComponent: (
    mask: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
  ) =>
    invoke<number[][][]>('skeletonize_component', {
      mask: mask.slice().buffer,
      width,
      height,
      x,
      y,
    }),

  /**
   * Skeletonize every component of a mask into open centerline polylines.
   * `minArea` drops specks as in `vectorizeMask`; `maxShapes` caps *components*,
   * not polylines, since one branched structure yields several.
   */
  skeletonizeMask: (
    mask: Uint8Array,
    width: number,
    height: number,
    minArea = 64,
    maxShapes = 64,
  ) =>
    invoke<number[][][]>('skeletonize_mask', {
      mask: mask.slice().buffer,
      width,
      height,
      minArea,
      maxShapes,
    }),

  createProject: (projectName: string, path: string, config: ProjectConfig) =>
    invoke('create_project', {
      projectName: projectName,
      path: path,
      config: config,
    }),
  openProject: (path: string) =>
    invoke<ProjectConfig>('open_project', { path }),

  closeProject: () => invoke('close_project'),

  // ── Segmentation-head lab ─────────────────────────────────────────────────
  mlListEncoders: () => invoke<EncoderStatus[]>('ml_list_encoders'),
  mlDownloadEncoder: (encoderId: string) =>
    invoke<string>('ml_download_encoder', { encoderId }),
  mlDatasetSummary: () => invoke<DatasetSummary>('ml_dataset_summary'),
  mlTrainModel: (options: TrainOptions) =>
    invoke<TrainSummary>('ml_train_model', { options }),
  mlModelStatus: () => invoke<TrainSummary | null>('ml_model_status'),
  /**
   * Restore the head saved in the open project, if any. Null when the project
   * has no model, or has one this build cannot read — both mean "retrain".
   */
  /** Discard the saved model, from both the project file and this session. */
  mlForgetModel: () => invoke<boolean>('ml_forget_model'),
  /** Ask the running fit to stop at the next epoch; the head it has is kept. */
  mlStopTraining: () => invoke<void>('ml_stop_training'),
  mlStorageUsage: () => invoke<StorageUsage>('ml_storage_usage'),
  /** Deletes cached features only; downloaded encoder weights are kept. */
  mlClearFeatureCache: () => invoke<number>('ml_clear_feature_cache'),
  mlPredictFrame: (frameId: number, scribbles?: ScribbleInput) =>
    invoke<PredictedFrame>('ml_predict_frame', { frameId, scribbles }),

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
