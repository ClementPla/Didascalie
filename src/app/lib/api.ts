import { invoke } from '@tauri-apps/api/core';

// Generated from the Rust structs by ts-rs: IPC types are not mirrored by
// hand.
import type { ScanOptions } from './generated/ScanOptions';
import type { ScanResult } from './generated/ScanResult';
import type { AddImagesResult } from './generated/AddImagesResult';
import type { EditImpact } from './generated/EditImpact';
import type { ProjectEdit } from './generated/ProjectEdit';
import type { TaskKind } from './generated/TaskKind';
import type { AgreementReport } from './generated/AgreementReport';
import type { CaseScore } from './generated/CaseScore';
import type { ComparisonStyle } from './generated/ComparisonStyle';
import type { FrameBasis } from './generated/FrameBasis';
import type { LabelAgreement } from './generated/LabelAgreement';
import type { PairAgreement } from './generated/PairAgreement';
import type { Role } from './generated/Role';
import type { TaskAgreement } from './generated/TaskAgreement';
import type { UserChange } from './generated/UserChange';
import type { UserFootprint } from './generated/UserFootprint';
import type { UserInfo } from './generated/UserInfo';

export type {
  ScanOptions,
  ScanResult,
  AddImagesResult,
  EditImpact,
  ProjectEdit,
  TaskKind,
  AgreementReport,
  CaseScore,
  ComparisonStyle,
  FrameBasis,
  LabelAgreement,
  PairAgreement,
  Role,
  TaskAgreement,
  UserChange,
  UserFootprint,
  UserInfo,
};
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
  /** Other paths the image folder is reached by, on other computers. */
  input_folder_alternates?: string[];
  images_embedded: boolean;
  embed_threshold_kb: number;
  segmentation_enabled: boolean;
  classification_enabled: boolean;
  instance_segmentation_enabled: boolean;
  text_description_enabled: boolean;
  input_regex: string;
  recursive: boolean;
  folders_as_sequences: boolean;
  segmentation_labels?: LabelConfig[];
  classification_tasks?: MulticlassConfig[];
  multilabel_task?: MultilabelConfig;
  text_fields?: string[];
}

export interface ImageFolderStatus {
  /** Null when the project has none (every image is embedded). */
  folder: string | null;
  /** Images are read from it, and it is not there. */
  missing: boolean;
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

/** See `get_sequence_classification`. */
export interface SequenceClassification {
  frameCount: number;
  /** One entry per distinct answer to a task. */
  answers: {
    taskName: string;
    isMultilabel: boolean;
    selectedClasses: string[];
    frameCount: number;
  }[];
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

export interface RegistrationSummary {
  referenceFrameId: number;
  movingFrameId: number;
  transformType: string;
  hasHomography: boolean;
  pairCount: number;
}

// ── Python bridge ───────────────────────────────────────────────────────────

export type PythonFunctionKind = 'keypoints' | 'seg' | 'sequence_seg';

export interface PythonFunction {
  name: string;
  kind: PythonFunctionKind;
  /** First line of the function's docstring; empty when it has none. */
  doc: string;
  /** Extras the function declared, e.g. `masks` or `active_label`. */
  wants: string[];
}

export interface PingReply {
  ok: boolean;
  protocol_version: number;
  /** Keypoint function names. */
  registered: string[];
  functions: PythonFunction[];
}

export interface PythonSegContext {
  /** Project labels in the order the editor lists them. */
  labels: { id: number; name: string; isInstance: boolean }[];
  activeLabelId: number | null;
  /** Value a stroke would write on the active label: instance id, or 1. */
  activeValue: number;
  /** Whether the function declared `masks`; they are only sent then. */
  sendMasks: boolean;
}

export interface PythonSegLayer {
  labelId: number;
  /** Paint onto the label's mask instead of replacing it. */
  additive: boolean;
  /** Base64 uint8 mask at native resolution, holding the values to write. */
  maskBase64: string;
}

export interface PythonSegFrame {
  layers: PythonSegLayer[];
  /** Returned label names the project does not have. */
  unknownLabels: string[];
}

export interface PythonSequenceReport {
  /** Frames that received at least one mask. */
  applied: number[];
  unknownLabels: string[];
}

type WirePair = [[number, number], [number, number]];

// ── Vector annotations ──────────────────────────────────────────────────────
// Handles are absolute image-space coordinates; a straight segment is a node
// whose handles equal its anchor.
export interface VectorNode {
  x: number;
  y: number;
  inX: number;
  inY: number;
  outX: number;
  outY: number;
  /** The two handles stay collinear when edited. */
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

export interface VectorAnnotationsWire {
  labelId: number;
  shapes: VectorShape[];
}

export type PropagationMode = 'replace';

export type PropagationSkipReason = 'sizeMismatch' | 'notFound';

export interface PropagationReport {
  applied: number[];
  skipped: { frameId: number; reason: PropagationSkipReason }[];
}

// ── Segmentation-head lab ────────────────────────────────────────────────────

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
  /** Annotated and reviewed. */
  annotatedFrames: number;
  /** Annotated but not reviewed, so excluded from training. */
  unreviewedFrames: number;
  labels: number;
  /** Labels plus background. */
  classes: number;
}

export interface EvalMetrics {
  accuracy: number;
  /** Mean over the classes present in the reference. */
  meanDice: number;
  perClassDice: number[];
}

export interface TrainOptions {
  /** Omit for the local feature basis alone. */
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

/** Payload of `ml-train-progress`, emitted once per epoch. */
export interface TrainTick {
  budget: number;
  repeat: number;
  epoch: number;
  epochs: number;
  loss: number;
  /** Fit index within a sweep; both 0 for a single training run. */
  point: number;
  points: number;
  epochMs: number;
  elapsedMs: number;
  /** Projected time left across the whole job. */
  etaMs: number;
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
  /** Display image downsampled to `maxDim`; `frame.width/height` stay native. */
  getFrameOverview: (frameId: number, maxDim: number) =>
    invoke<FrameImage>('get_frame_overview', { frameId, maxDim }),
  /** A native-resolution RGBA tile of a frame (row-major, `width*height*4`
   *  bytes). */
  getFrameTile: (
    frameId: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ) =>
    invoke<ArrayBuffer>('get_frame_tile', { frameId, x, y, width, height }),
  /** Erase every annotation on every frame of a sequence, returning how many
   *  frames carried one. Not undoable. */
  clearSequenceAnnotations: (sequenceId: number) =>
    invoke<number>('clear_sequence_annotations', { sequenceId }),

  /** Every frame's pixels as 8-bit luminance, stacked in `frameIds` order
   *  (`W*H*D` bytes). All frames must share one size. */
  loadSequenceImageVolume: (frameIds: number[]) =>
    invoke<ArrayBuffer>('load_sequence_image_volume', { frameIds }),
  /** One label's masks for every frame, stacked in `frameIds` order (`W*H*D`
   *  bytes). */
  loadLabelVolume: (frameIds: number[], labelId: number) =>
    invoke<ArrayBuffer>('load_label_volume', { frameIds, labelId }),

  /** A frame's image as encoded bytes, its longest side at most `maxDim`
   *  (0 = native). */
  getFramePreview: (frameId: number, maxDim: number) =>
    invoke<ArrayBuffer>('get_frame_preview', { frameId, maxDim }),
  /**
   * A frame's labels composited to RGBA at preview size: an 8-byte header
   * (width, height as little-endian uint32) then `width*height*4` bytes, or
   * nothing when there is nothing to draw. `labels` lists what to draw, bottom
   * to top, each with its 256-entry RGBA palette.
   */
  renderLabelOverlay: (
    frameId: number,
    maxDim: number,
    labels: { id: number; palette: number[] }[],
    edgesOnly: boolean,
  ) =>
    invoke<ArrayBuffer>('render_label_overlay', {
      frameId,
      maxDim,
      labels,
      edgesOnly,
    }),

  /** Close the detached view window titled `title`. */
  closeDetachedWindow: (title: string) =>
    invoke<void>('close_detached_window', { title }),

  getFrameThumbnail: (frameId: number, maxSize: number) =>
    invoke<FrameImage>('get_frame_thumbnail', { frameId, maxSize }),

  getProgress: () => invoke<[number, number]>('get_progress'),

  loadAnnotations: (frameId: number) =>
    invoke<AnnotationResponse[]>('load_annotations', { frameId }),

  saveAnnotation: (frameId: number, labelId: number, maskData: Uint8Array) => {
    // Raw bytes (Rust receives Vec<u8>), not a JSON number array. A copy, in case
    // the IPC layer transfers the buffer.
    return invoke<void>('save_annotation', {
      frameId,
      labelId,
      maskData: maskData.slice().buffer,
    });
  },

  loadVectorAnnotations: (frameId: number) =>
    invoke<VectorAnnotationsWire[]>('load_vector_annotations', { frameId }),

  /** Replace all vector shapes of one (frame, label). */
  saveVectorAnnotations: (
    frameId: number,
    labelId: number,
    shapes: VectorShape[],
  ) => invoke<void>('save_vector_annotations', { frameId, labelId, shapes }),

  /** Copy one frame's segmentation annotations, raster and vector, onto other
   *  frames. `labelIds` restricts the copy (`null`: every label). Targets of
   *  another size are skipped. */
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

  /** Trace every component of a mask into simplified polygons. `minArea` drops
   *  specks. */
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

  /** Skeletonize the component under (x, y) into open centreline polylines.
   *  Empty when the pixel is background. */
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

  /** Skeletonize every component of a mask. `maxShapes` caps components, not
   *  polylines. */
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

  getImageFolder: () => invoke<ImageFolderStatus>('get_image_folder'),
  setImageFolder: (path: string) =>
    invoke<ImageFolderStatus>('set_image_folder', { path }),

  closeProject: () => invoke('close_project'),

  // ── Segmentation-head lab ─────────────────────────────────────────────────
  mlListEncoders: () => invoke<EncoderStatus[]>('ml_list_encoders'),
  mlDownloadEncoder: (encoderId: string) =>
    invoke<string>('ml_download_encoder', { encoderId }),
  mlDatasetSummary: () => invoke<DatasetSummary>('ml_dataset_summary'),
  mlTrainModel: (options: TrainOptions) =>
    invoke<TrainSummary>('ml_train_model', { options }),
  mlModelStatus: () => invoke<TrainSummary | null>('ml_model_status'),
  /** Discard the saved model, from the project file and this session. */
  mlForgetModel: () => invoke<boolean>('ml_forget_model'),
  /** Ask the running fit to stop at the next epoch; its head is kept. */
  mlStopTraining: () => invoke<void>('ml_stop_training'),
  mlStorageUsage: () => invoke<StorageUsage>('ml_storage_usage'),
  /** Cached features only; encoder weights are kept. */
  mlClearFeatureCache: () => invoke<number>('ml_clear_feature_cache'),
  mlPredictFrame: (frameId: number, scribbles?: ScribbleInput) =>
    invoke<PredictedFrame>('ml_predict_frame', { frameId, scribbles }),

  scanAndImportFolder: (options: ScanOptions) =>
    invoke<ScanResult>('scan_and_import_folder', { options }),

  // ── User accounts ─────────────────────────────────────────────────────────

  listUsers: () => invoke<UserInfo[]>('list_users'),

  /** The logged-in account, or null while the project waits for one. */
  currentUser: () => invoke<UserInfo | null>('current_user'),

  login: (userId: number, password: string | null) =>
    invoke<UserInfo>('login', { userId, password }),

  logout: () => invoke<void>('logout'),

  /** Create an editor account. Does not log it in. */
  registerUser: (name: string, password: string | null) =>
    invoke<UserInfo>('register_user', { name, password }),

  updateUser: (userId: number, change: UserChange) =>
    invoke<UserInfo>('update_user', { userId, change }),

  userFootprint: (userId: number) =>
    invoke<UserFootprint>('user_footprint', { userId }),

  deleteUser: (userId: number) => invoke<void>('delete_user', { userId }),

  /** Agreement between every pair of graders. Administrators only. */
  intergraderReport: (basis: FrameBasis) =>
    invoke<AgreementReport>('intergrader_report', { basis }),

  /** The frames behind one pair's score for one label, least agreement first. */
  intergraderCases: (a: number, b: number, labelId: number, basis: FrameBasis) =>
    invoke<CaseScore[]>('intergrader_cases', { a, b, labelId, basis }),

  /** One frame as JPEG bytes, with both graders' regions for a label drawn over
   *  it as `style` says. `overlay: false` gives the bare image. */
  intergraderCaseImage: (
    frameId: number,
    a: number,
    b: number,
    labelId: number,
    maxDim: number,
    overlay: boolean,
    style: ComparisonStyle,
  ) =>
    invoke<ArrayBuffer>('intergrader_case_image', {
      frameId,
      a,
      b,
      labelId,
      maxDim,
      overlay,
      style,
    }),

  addImagesToProject: (options: ScanOptions) =>
    invoke<AddImagesResult>('add_images_to_project', { options }),

  projectEditImpact: (edit: ProjectEdit) =>
    invoke<EditImpact>('project_edit_impact', { edit }),

  /** Change the open project's configuration, with every stored annotation
   *  that depends on it. Returns the new configuration. */
  applyProjectEdit: (edit: ProjectEdit) =>
    invoke<ProjectConfig>('apply_project_edit', { edit }),

  setFrameReviewed: (frameId: number, reviewed: boolean) =>
    invoke('set_frame_reviewed', {
      frameId: frameId,
      reviewed: reviewed,
    }),

  getFramesCount: () => invoke<number>('get_frames_count'),
  getSequencesCount: () => invoke<number>('get_sequences_count'),
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

  getSequenceClassification: (sequenceId: number) =>
    invoke<SequenceClassification>('get_sequence_classification', {
      sequenceId,
    }),

  /** Give every frame of a sequence the same answer to a task. Resolves to the
   *  number of frames. */
  saveSequenceClassification: (
    sequenceId: number,
    taskName: string,
    selectedClasses: string[],
    isMultilabel: boolean,
  ) =>
    invoke<number>('save_sequence_classification', {
      sequenceId,
      taskName,
      selectedClasses,
      isMultilabel,
    }),

  saveBatchClassifications: (classifications: BatchClassificationPayload[]) =>
    invoke<void>('save_batch_classifications', { classifications }),

  setFramesReviewed: (frameIds: number[], reviewed: boolean) =>
    invoke<void>('set_frames_reviewed', { frameIds, reviewed }),

  listLabels: () => invoke<LabelId[]>('list_labels'),

  listDatasetFormats: () => invoke<DatasetFormat[]>('list_dataset_formats'),

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

  /** Import annotations into the open project, matched by filename. */
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

  listRegistrations(sequenceId: number): Promise<RegistrationSummary[]> {
    return invoke('list_registrations', { sequenceId });
  },

  deleteRegistration(
    referenceFrameId: number,
    movingFrameId: number,
  ): Promise<void> {
    return invoke('delete_registration', { referenceFrameId, movingFrameId });
  },

  // ── Projects on a device's shared storage (Android) ───────────────────────

  /** Copy a project picked on the device (a path or a `content://` URI) into
   *  the application's storage. Returns the copy's path. */
  importProjectFile: (location: string) =>
    invoke<string>('import_project_file', { location }),

  /** The project the application was opened with, already imported, or null. */
  takeIncomingProject: () => invoke<string | null>('take_incoming_project'),

  exportProjectFile: (location: string) =>
    invoke<void>('export_project_file', { location }),

  /** The remote-control port: the one in use, and the one set for next launch. */
  getListenPort: () =>
    invoke<{ active: number; configured: number }>('get_listen_port'),

  /** Takes effect the next time the application starts. */
  setListenPort: (port: number) => invoke<void>('set_listen_port', { port }),

  /** Ping the Python server and make it the bridge's endpoint. `probe` is the
   *  background discovery poll. */
  inferenceConnect: (host: string, port: number, probe = false) =>
    invoke<PingReply>('inference_connect', { host, port, probe }),

  /** Run a `@register_seg` function on one frame. */
  pythonSegmentFrame: (
    name: string,
    frameId: number,
    frameIndex: number,
    context: PythonSegContext,
  ) =>
    invoke<PythonSegFrame>('python_segment_frame', {
      name,
      frameId,
      frameIndex,
      context,
    }),

  /** Run a `@register_sequence_seg` function over `frameIds`. Not undoable.
   *  Progress arrives as `python-seg-progress`. */
  pythonSegmentSequence: (
    name: string,
    frameIds: number[],
    currentFrameId: number | null,
    context: PythonSegContext,
  ) =>
    invoke<PythonSequenceReport>('python_segment_sequence', {
      name,
      frameIds,
      currentFrameId,
      context,
    }),

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
