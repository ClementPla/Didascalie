import { invoke } from '@tauri-apps/api/core';

import { encodeRle8 } from './rle8';

// Generated from the Rust structs by ts-rs: IPC types are not mirrored by
// hand.
import type { ScanOptions } from './generated/ScanOptions';
import type { ScanResult } from './generated/ScanResult';
import type { AddImagesResult } from './generated/AddImagesResult';
import type { ImportProgress } from './generated/ImportProgress';
import type { MicroscopyImport } from './generated/MicroscopyImport';
import type { MicroscopyInspection } from './generated/MicroscopyInspection';
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
import type { Frame } from './generated/Frame';
import type { GallerySequence } from './generated/GallerySequence';
import type { KeypointPair as KeypointPairWire } from './generated/KeypointPair';
import type { LabelInfo } from './generated/LabelInfo';
import type { PropagationMode } from './generated/PropagationMode';
import type { PropagationReport } from './generated/PropagationReport';
import type { RestoreReport } from './generated/RestoreReport';
import type { RegistrationData } from './generated/RegistrationData';
import type { RegistrationSummary } from './generated/RegistrationSummary';
import type { Sequence } from './generated/Sequence';
import type { SkipReason } from './generated/SkipReason';
import type { SkippedFrame } from './generated/SkippedFrame';
import type { VectorNode } from './generated/VectorNode';
import type { VectorShape } from './generated/VectorShape';
import type { ChannelDisplay } from './generated/ChannelDisplay';
import type { DisplaySettings } from './generated/DisplaySettings';
import type { FrameDisplay } from './generated/FrameDisplay';
import type { PixelInfo } from './generated/PixelInfo';
import type { RenderedImage } from './generated/RenderedImage';
import type { ValueRange } from './generated/ValueRange';
import type { AnnotationResponse } from './generated/AnnotationResponse';
import type { BatchClassificationPayload } from './generated/BatchClassificationPayload';
import type { ClassificationData } from './generated/ClassificationData';
import type { DatasetFormat } from './generated/DatasetFormat';
import type { DatasetSummary } from './generated/DatasetSummary';
import type { EncoderStatus } from './generated/EncoderStatus';
import type { EvalMetrics } from './generated/EvalMetrics';
import type { ExportResult } from './generated/ExportResult';
import type { FormatChoice } from './generated/FormatChoice';
import type { FormatOption } from './generated/FormatOption';
import type { FrameImage } from './generated/FrameImage';
import type { ImageFolderStatus } from './generated/ImageFolderStatus';
import type { ImportResult } from './generated/ImportResult';
import type { LabelConfig } from './generated/LabelConfig';
import type { LabelId } from './generated/LabelId';
import type { MlProgress } from './generated/MlProgress';
import type { MulticlassConfig } from './generated/MulticlassConfig';
import type { MultilabelConfig } from './generated/MultilabelConfig';
import type { PingReply } from './generated/PingReply';
import type { PredictedFrame } from './generated/PredictedFrame';
import type { PredictedMask } from './generated/PredictedMask';
import type { ProjectConfig } from './generated/ProjectConfig';
import type { PythonFunction } from './generated/PythonFunction';
import type { PythonSegContext } from './generated/PythonSegContext';
import type { PythonSegFrame } from './generated/PythonSegFrame';
import type { PythonSegLayer } from './generated/PythonSegLayer';
import type { PythonSequenceReport } from './generated/PythonSequenceReport';
import type { ScribbleInput } from './generated/ScribbleInput';
import type { SequenceClassification } from './generated/SequenceClassification';
import type { StorageUsage } from './generated/StorageUsage';
import type { TextDescriptionData } from './generated/TextDescriptionData';
import type { TrainOptions } from './generated/TrainOptions';
import type { TrainSummary } from './generated/TrainSummary';
import type { TrainTick } from './generated/TrainTick';
import type { VectorAnnotationsWire } from './generated/VectorAnnotationsWire';

export type {
  ScanOptions,
  ScanResult,
  AddImagesResult,
  ImportProgress,
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
  Frame,
  GallerySequence,
  LabelInfo,
  PropagationMode,
  PropagationReport,
  RestoreReport,
  RegistrationData,
  RegistrationSummary,
  Sequence,
  SkipReason,
  SkippedFrame,
  VectorNode,
  VectorShape,
  AnnotationResponse,
  BatchClassificationPayload,
  ClassificationData,
  DatasetFormat,
  DatasetSummary,
  EncoderStatus,
  EvalMetrics,
  ExportResult,
  FormatChoice,
  FormatOption,
  FrameImage,
  ImageFolderStatus,
  ImportResult,
  LabelConfig,
  LabelId,
  MlProgress,
  MulticlassConfig,
  MultilabelConfig,
  PingReply,
  PredictedFrame,
  PredictedMask,
  ProjectConfig,
  PythonFunction,
  PythonSegContext,
  PythonSegFrame,
  PythonSegLayer,
  PythonSequenceReport,
  ScribbleInput,
  SequenceClassification,
  StorageUsage,
  TextDescriptionData,
  TrainOptions,
  TrainSummary,
  TrainTick,
  VectorAnnotationsWire,
  ChannelDisplay,
  DisplaySettings,
  PixelInfo,
  RenderedImage,
  ValueRange,
  FrameDisplay,
};
// ── Pluggable dataset formats (COCO, YOLO, NIfTI, …) ──────────────────────────

export type KeypointSource = 'user' | 'prefilled';
/** A pair as the frontend holds it: the wire type, plus where it came from
 *  (not stored). */
export type KeypointPair = KeypointPairWire & { source?: KeypointSource };

// ── Python bridge ───────────────────────────────────────────────────────────

export type PythonFunctionKind = PythonFunction['kind'];

type WirePair = [[number, number], [number, number]];

// ── Vector annotations ──────────────────────────────────────────────────────
// Handles are absolute image-space coordinates; a straight segment is a node
// whose handles equal its anchor.
// ── Segmentation-head lab ────────────────────────────────────────────────────

/** The refinement options Otsu and flood fill share. */
export interface RefineOptions {
  inverse: boolean;
  smooth: number;
  fillHoles: boolean;
  connectedness: boolean;
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
  // ── Raw pixels (native bit depth) ──────────────────────────────────────────

  /** The image the editor shows for a frame: the stored 8-bit image (or an
   *  overview ≤ `maxDim`), or a render of deeper pixels with `raw` set. */
  loadFrameDisplay: (frameId: number, maxDim: number) =>
    invoke<FrameDisplay>('load_frame_display', { frameId, maxDim }),

  /** What a frame's pixels are: size, channels, sample type, value ranges. */
  framePixelInfo: (frameId: number) =>
    invoke<PixelInfo>('frame_pixel_info', { frameId }),

  /** A channel's histogram in `bins` bins over `[min, max]`. */
  frameHistogram: (
    frameId: number,
    channel: number,
    bins: number,
    min: number,
    max: number,
    log = false,
  ) => invoke<number[]>('frame_histogram', { frameId, channel, bins, min, max, log }),

  /** The raw value of every channel at a native pixel; empty outside the frame. */
  pixelValues: (frameId: number, x: number, y: number) =>
    invoke<number[]>('pixel_values', { frameId, x, y }),

  /** The display a frame is shown with: its sequence's, or the automatic one. */
  getDisplaySettings: (frameId: number) =>
    invoke<DisplaySettings>('get_display_settings', { frameId }),

  /** The automatic display for a frame, whatever is stored. */
  autoDisplaySettings: (frameId: number, low?: number, high?: number) =>
    invoke<DisplaySettings>('auto_display_settings', { frameId, low, high }),

  /** The frame's raw values, box-averaged to at most `maxDim` on a side, for
   *  previews: four little-endian u32 (width, height, channels, 0), then
   *  every channel's plane as little-endian f32. See `parsePreview`. */
  previewSamples: (frameId: number, maxDim: number) =>
    invoke<ArrayBuffer>('preview_samples', { frameId, maxDim }),

  /** Store the display of a sequence's frames; `null` returns to automatic. */
  setDisplaySettings: (sequenceId: number, settings: DisplaySettings | null) =>
    invoke<void>('set_display_settings', { sequenceId, settings }),

  /** The frame rendered to 8-bit with its display, longest side ≤ `maxDim`
   *  (0: native size). */
  renderFrameImage: (frameId: number, maxDim: number) =>
    invoke<RenderedImage>('render_frame_image', { frameId, maxDim }),

  /** A native-resolution RGBA tile rendered with the frame's display, laid out
   *  like `getFrameTile`. */
  renderFrameTile: (frameId: number, x: number, y: number, width: number, height: number) =>
    invoke<ArrayBuffer>('render_frame_tile', { frameId, x, y, width, height }),

  /** Erase every annotation on every frame of a sequence, returning how many
   *  frames carried one. Not undoable. */
  /** Copy the stored annotations of these frames (undo of multi-frame
   *  operations); returns the snapshot's id. */
  snapshotTake: (frameIds: number[]) => invoke<number>('snapshot_take', { frameIds }),
  /** Put snapshot `target` back on its frames, except those that no longer
   *  match snapshot `expected` (edited since). */
  snapshotRestore: (target: number, expected: number) =>
    invoke<RestoreReport>('snapshot_restore', { target, expected }),
  snapshotDrop: (ids: number[]) => invoke<void>('snapshot_drop', { ids }),
  snapshotClear: () => invoke<void>('snapshot_clear'),

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

  /** Store one label's mask, encoded here: the encoding is a few kilobytes
   *  and goes as a raw body, where the mask itself would go as one JSON number
   *  per pixel. */
  saveAnnotation: (frameId: number, labelId: number, maskData: Uint8Array) =>
    invoke<void>('save_annotation', encodeRle8(maskData), {
      headers: { 'Frame-Id': String(frameId), 'Label-Id': String(labelId) },
    }),

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

  // ── Stroke post-processing: RGBA bytes in, a mask region out ──────────────

  /** Otsu threshold of the image under the stroke's mask. */
  otsuSegmentation: (
    args: {
      mask: ArrayBufferLike;
      image: ArrayBufferLike;
      denoiseSigma: number;
      width: number;
      height: number;
    } & RefineOptions,
  ) => invoke<ArrayBufferLike>('otsu_segmentation', { ...args }),

  /** Otsu on the raw pixels of a frame deeper than 8 bits, read from the Rust
   *  cache through the display window. `mask` is the stroke region as RGBA;
   *  `source` null reads the brightest visible channel. */
  otsuSegmentationRaw: (
    args: {
      frameId: number;
      x: number;
      y: number;
      width: number;
      height: number;
      mask: ArrayBufferLike;
      source: number | null;
      denoiseSigma: number;
    } & RefineOptions,
  ) => invoke<ArrayBufferLike>('otsu_segmentation_raw', { ...args }),

  /** Flood fill on raw pixels, within `tolerance` % of the display range of
   *  the clicked pixel. (startX, startY) are relative to the region. */
  floodFillRaw: (
    args: {
      frameId: number;
      x: number;
      y: number;
      width: number;
      height: number;
      startX: number;
      startY: number;
      source: number | null;
      tolerance: number;
    } & RefineOptions,
  ) => invoke<ArrayBufferLike>('flood_fill_raw', { ...args }),

  /** Flood fill by colour from (startX, startY), within `tolerance`. */
  floodFillMask: (
    args: {
      image: ArrayBufferLike;
      width: number;
      height: number;
      startX: number;
      startY: number;
      tolerance: number;
    } & RefineOptions,
  ) => invoke<ArrayBufferLike>('flood_fill_mask', { ...args }),

  /** Keep the superpixels a stroke covers. `image` may be empty once the map
   *  for this image is computed (`computeMap: false`). */
  superpixelRefine: (args: {
    image: ArrayBufferLike | number[];
    brush: ArrayBufferLike;
    width: number;
    height: number;
    computeMap: boolean;
    targetCount: number;
    similarityThreshold: number;
    minOverlapFraction: number;
  }) => invoke<ArrayBufferLike>('superpixel_refine', args),

  /** The superpixel boundaries as an RGBA overlay. */
  superpixelOverlay: (args: {
    image: ArrayBufferLike | number[];
    width: number;
    height: number;
    computeMap: boolean;
    targetCount: number;
  }) => invoke<Uint8ClampedArray>('superpixel_overlay', args),

  /** SAM-style refinement of a coarse mask. `image` may be empty once the
   *  encoder features are extracted (`extractFeatures: false`). */
  maskSamSegment: (args: {
    coarseMask: boolean[] | Uint8Array;
    image: ArrayBufferLike | number[];
    threshold: number;
    width: number;
    height: number;
    extractFeatures: boolean;
  }) => invoke<ArrayBufferLike>('mask_sam_segment', args),

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

  /** For each path, whether a file exists there. */
  pathsExist: (paths: string[]) => invoke<boolean[]>('paths_exist', { paths }),

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

  /** The microscopy files a folder scan with these options would take. */
  findMicroscopyFiles: (options: ScanOptions) =>
    invoke<string[]>('find_microscopy_files', { options }),

  /** Describe microscopy files (series, channels, levels) before an import. */
  inspectMicroscopy: (paths: string[]) =>
    invoke<MicroscopyInspection[]>('inspect_microscopy', { paths }),

  /** Convert and add microscopy files to the open project, one sequence per series. */
  importMicroscopy: (files: MicroscopyImport[]) =>
    invoke<AddImagesResult>('import_microscopy', { files }),

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
