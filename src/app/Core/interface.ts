export interface SegLabel {
  label: string;
  color: string;
  isVisible: boolean;
  shades: string[] | null;
}

export const CombinedLabel = {
  label: 'Combined',
  color: '#ffffff',
  isVisible: true,
  shades: null,
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

export interface TextLabel {
  name: string;
  text: string;
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

// This interface is used to store the setup of classification and multilabel classes in the project_config.json file
export interface MulticlassInterface {
  name: string;
  classes: string[];
}
export interface MultilabelInterface {
  name: string;
  classes: string[];
}

export interface ProjectConfig {
  project_name: string;
  input_dir: string;
  output_dir: string;
  is_segmentation: boolean;
  is_classification: boolean;
  is_instance_segmentation: boolean;
  is_bbox_detection: boolean;
  has_text_description: boolean;
  is_multiframes: boolean;
  group_labels: boolean;
  segmentation_classes: null | string[];
  classification_classes: null | MulticlassInterface[];
  classification_multilabel: null | MultilabelInterface;
  text_names: null | string[];
  default_colors: null | string[];

}

export interface ImageFromCLI {
  image_path: string;
  mask_data: string[] | null;
  segmentation_classes: string[] | null;
  classification_classes: string[] | null;
  classification_multilabel: string[] | null;
  texts: string[] | null;
  width: number;
  height: number;
}


export interface ProjectFile {
  root: string;
  project_name: string;
}


export interface LabelFormat {
  masksName: string[];
  masks: (Blob | string)[]; // Saved as Blob, loaded as string
  colors: string[];
  shades: string[][] | null;
  textsNames: string[];
  texts: string[] | null;
}


export type DownloadingInformations = {
  filename: string;
  progress: number;
  downloaded: boolean;
  total: number;
}