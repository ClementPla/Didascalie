export interface SegLabel {
  id: number;
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
  id: -1,
};

export interface SegInstance {
  id: number;
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

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// How classification and multilabel classes are stored in the project config.
export interface MulticlassInterface {
  name: string;
  classes: string[];
}
export interface MultilabelInterface {
  name: string;
  classes: string[];
}

export interface TextLabel {
  content: string;
  name: string;
}