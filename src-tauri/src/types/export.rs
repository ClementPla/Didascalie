// types/export.rs
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ExportOptions {
    pub output_folder: String,
    pub individual_mask: bool,
    pub combined_mask: bool,
    pub colormap: bool,
    pub only_reviewed: bool,
    pub instance_segmentation: bool,
    pub classifications: bool,  
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub total_exported: u32,
    pub errors: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub current: u32,
    pub total: u32,
    pub current_file: String,
}


// Add these structs
pub struct ClassificationTaskInfo {
    pub name: String,
    pub classes: Vec<String>,
    pub is_multilabel: bool,
}

pub struct FrameClassification {
    pub frame_id: i64,
    pub relative_path: String,
    pub task_name: String,
    pub selected_classes: Vec<String>,
    pub is_multilabel: bool,
}

