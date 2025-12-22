import { MulticlassInterface, MultilabelInterface } from "../../Core/interface";

export interface DownloadProgress {
  downloaded: boolean;
  progress: number;
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