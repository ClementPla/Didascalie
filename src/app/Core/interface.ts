export interface SegLabel {
  label: string;
  color: string;
  isVisible: boolean;
  shades: string[] | null;
}

export interface SegInstance {
  label: SegLabel;
  instance: number;
  shade: string;
}

export interface BboxLabel {
  label: SegLabel;
  bbox: Rect;
  instance: number;
}

export interface Thumbnail {
  name: Promise<string>;
  thumbnailPath: Promise<string>;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewbox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export interface UndoRedoCanvasElement {
  data: Blob | Blob[];
  index: number;
}

export interface MulticlassInterface {
  name: string;
  classes: string[];
  default: string | null;
}

export interface MultilabelInterface {
  name: string;
  classes: string[];
  default: string[] | null;
}

export interface ProjectConfig {
  project_name: string;
  input_dir: string;
  output_dir: string;
  is_segmentation: boolean;
  is_classification: boolean;
  is_instance_segmentation: boolean;
  is_bbox_detection: boolean;
  segmentation_classes: null | string[];
  classification_classes: null | MulticlassInterface[];
  classification_multilabel: null | MultilabelInterface;
}

export interface ImageFromCLI {
  image_path: string;
  mask_data: string[] | null;
  segmentation_classes: string[] | null;
  classification_classes: string[] | null;
  classification_multilabel: string[] | null;
}


export interface ProjectFile{
  root: string;
  project_name: string;
}