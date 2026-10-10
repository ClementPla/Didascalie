//! Project configuration, as stored in the `.dida` file.
//!
//! Every type here is serialised whole into the `project.config` column: the
//! field names are the stored keys. No `rename_all = "camelCase"`, which would
//! make existing projects unreadable; renaming a field takes a schema
//! migration.

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
    /// Other paths the image folder is reached by, from other computers. See
    /// `commands::project::resolve_image_folder`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_folder_alternates: Vec<String>,
    pub images_embedded: bool,
    /// Files smaller than this are embedded even when `images_embedded` is off.
    /// Missing or `null` (as some files written from Python have it) reads as
    /// the default.
    #[serde(
        default = "default_embed_threshold_kb",
        deserialize_with = "embed_threshold_kb_or_default"
    )]
    pub embed_threshold_kb: u32,
    
    pub segmentation_enabled: bool,
    pub classification_enabled: bool,
    pub instance_segmentation_enabled: bool,
    pub text_description_enabled: bool,
    
    pub input_regex: String,
    pub recursive: bool,
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

fn embed_threshold_kb_or_default<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<u32>::deserialize(deserializer)?.unwrap_or_else(default_embed_threshold_kb))
}

impl Default for ProjectConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            input_folder: None,
            input_folder_alternates: Vec::new(),
            images_embedded: false,
            embed_threshold_kb: default_embed_threshold_kb(),
            segmentation_enabled: true,
            classification_enabled: false,
            instance_segmentation_enabled: false,
            text_description_enabled: false, 
            input_regex: String::from(r"\.(png|jpg|jpeg|bmp|tiff?|mp4|m4v|mov|mkv|webm|avi)$"),
            recursive: false,
            segmentation_labels: None,
            classification_tasks: None,
            multilabel_task: None,
            text_fields: None,
            folders_as_sequences: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ProjectConfig;

    /// The config of a project written from Python, as found in the field.
    fn config_with(threshold: &str) -> String {
        format!(
            r#"{{"name": "p", "input_folder": null, "images_embedded": true, {threshold}
               "segmentation_enabled": true, "classification_enabled": false,
               "instance_segmentation_enabled": false, "text_description_enabled": false,
               "input_regex": "x", "recursive": true, "folders_as_sequences": false}}"#
        )
    }

    #[test]
    fn a_null_embed_threshold_reads_as_the_default() {
        let config: ProjectConfig =
            serde_json::from_str(&config_with(r#""embed_threshold_kb": null,"#)).unwrap();
        assert_eq!(config.embed_threshold_kb, 100);
    }

    #[test]
    fn a_missing_embed_threshold_reads_as_the_default() {
        let config: ProjectConfig = serde_json::from_str(&config_with("")).unwrap();
        assert_eq!(config.embed_threshold_kb, 100);
    }

    #[test]
    fn a_stored_embed_threshold_is_kept() {
        let config: ProjectConfig =
            serde_json::from_str(&config_with(r#""embed_threshold_kb": 250,"#)).unwrap();
        assert_eq!(config.embed_threshold_kb, 250);
    }
}
