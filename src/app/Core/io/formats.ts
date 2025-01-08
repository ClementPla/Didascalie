import { invoke } from "@tauri-apps/api/core";
import { XMLBuilder } from "fast-xml-parser";

export interface LabelFormat {
    masksName: string[];
    masks: (Blob | string)[]; // Saved as Blob, loaded as string
    labels: string[];
    colors: string[];
    shades: string[][] | null;
    multiclass: string[] | null;
    multilabel: string[] | null;
}
