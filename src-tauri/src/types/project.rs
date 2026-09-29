//! Project configuration, as stored in the `.dida` file.
//!
//! # These field names are an on-disk format, not an API
//!
//! Every type here is serialised whole into the `project.config` column by
//! `queries::insert_project` and read back by `get_project_config`. The field
//! names *are* the stored keys, so `#[serde(rename_all = "camelCase")]` — which
//! the types crossing the Tauri boundary otherwise use — would make every
//! project created before the change unreadable, silently: serde would find no
//! `input_folder` and fail the whole config.
//!
//! They reach the frontend too, which is why the casing looks inconsistent next
//! to `commands::*`. It is not an oversight. If these ever need to change,
//! it takes a schema migration that rewrites stored config, not an attribute.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LabelConfig {
    pub name: String,
    pub color: String,
    pub shades: Option<Vec<String>>,  // For instance segmentation
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MulticlassConfig {
    pub name: String,
    pub classes: Vec<String>,
    pub default: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MultilabelConfig {
    pub name: String,
    pub classes: Vec<String>,
    pub default: Option<Vec<String>>,
}


#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectConfig {
    pub name: String,
    pub input_folder: Option<String>,      // None if images embedded
    pub images_embedded: bool,
    /// Files smaller than this are embedded even when `images_embedded` is off.
    ///
    /// `serde(default)` because project files written before this field existed
    /// do not carry it, and they must still open. The TypeScript side declared
    /// it long before the Rust side did, which made it `undefined` after every
    /// project open and broke the next folder scan.
    #[serde(default = "default_embed_threshold_kb")]
    pub embed_threshold_kb: u32,
    
    // Task types
    pub segmentation_enabled: bool,
    pub classification_enabled: bool,
    pub instance_segmentation_enabled: bool,
    pub text_description_enabled: bool,
    
    // Input settings
    pub input_regex: String,
    pub recursive: bool,
    // Labels
    pub segmentation_labels: Option<Vec<LabelConfig>>,
    pub classification_tasks: Option<Vec<MulticlassConfig>>,
    pub multilabel_task: Option<MultilabelConfig>,
    pub text_fields: Option<Vec<String>>,
    pub folders_as_sequences: bool,
}

/// Matches DEFAULT_PROJECT_CONFIG on the TypeScript side.
fn default_embed_threshold_kb() -> u32 {
    100
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            input_folder: None,
            images_embedded: false,
            embed_threshold_kb: default_embed_threshold_kb(),
            segmentation_enabled: true,
            classification_enabled: false,
            instance_segmentation_enabled: false,
            text_description_enabled: false, 
            input_regex: String::from(r"\.(png|jpg|jpeg|bmp|tiff?)$"),
            recursive: false,
            segmentation_labels: None,
            classification_tasks: None,
            multilabel_task: None,
            text_fields: None,
            folders_as_sequences: false,
        }
    }
}

