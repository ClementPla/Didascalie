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



// This interface is used to store the setup of classification and multilabel classes in the project_config.json file
export interface MulticlassInterface {
  name: string;
  classes: string[];
}
export interface MultilabelInterface {
  name: string;
  classes: string[];
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
};


export interface TextLabel {
  content: string;
  name: string;
}