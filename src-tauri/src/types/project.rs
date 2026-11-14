//! Project configuration, as stored in the `.dida` file.
//!
//! Every type here is serialised whole into the `project.config` column: the
//! field names are the stored keys. No `rename_all = "camelCase"`, which would
//! make existing projects unreadable; renaming a field takes a schema
//! migration.

use ts_rs::TS;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct LabelConfig {
    pub name: String,
    pub color: String,
    #[ts(optional = nullable)]
    pub shades: Option<Vec<String>>,  // For instance segmentation
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct MulticlassConfig {
    pub name: String,
    pub classes: Vec<String>,
    #[ts(optional = nullable)]
    pub default: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct MultilabelConfig {
    pub name: String,
    pub classes: Vec<String>,
    #[ts(optional = nullable)]
    pub default: Option<Vec<String>>,
}

/// The number type of a regression value. SQLite stores every value as a
/// 64-bit `REAL`; the type decides how a value is rounded before it is stored,
/// and the dtype it is exported with.
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub enum RegressionType {
    #[default]
    Float32,
    Float64,
    Int32,
}

impl RegressionType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Float32 => "float32",
            Self::Float64 => "float64",
            Self::Int32 => "int32",
        }
    }

    /// `value` as this type holds it, or `None` when it does not fit. A
    /// `float32` is rounded to single precision, so what is read back is what
    /// was stored; an `int32` to the nearest integer.
    pub fn cast(self, value: f64) -> Option<f64> {
        match self {
            Self::Float64 => Some(value),
            Self::Float32 => {
                let single = value as f32;
                single.is_finite().then_some(single as f64)
            }
            Self::Int32 => {
                let whole = value.round();
                (whole >= i32::MIN as f64 && whole <= i32::MAX as f64).then_some(whole)
            }
        }
    }
}

/// One number a frame can be given (an age, a diameter, a score). A frame
/// holds at most one value per regression task and user.
#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct RegressionConfig {
    pub name: String,
    #[serde(default)]
    pub dtype: RegressionType,
    /// Smallest and largest value accepted, each optional on its own. Checked
    /// when a value is saved; values stored before a range was narrowed stay.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub min: Option<f64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max: Option<f64>,
}

impl RegressionConfig {
    /// The value to store for `value`: within the range, in the task's type.
    /// The range is checked on the value as entered, before rounding.
    pub fn conform(&self, value: f64) -> Result<f64, String> {
        if !value.is_finite() {
            return Err(format!("\"{}\" needs a finite number.", self.name));
        }
        let below = self.min.is_some_and(|min| value < min);
        let above = self.max.is_some_and(|max| value > max);
        if below || above {
            let range = match (self.min, self.max) {
                (Some(min), Some(max)) => format!("between {min} and {max}"),
                (Some(min), None) => format!("at least {min}"),
                (None, Some(max)) => format!("at most {max}"),
                (None, None) => unreachable!("a value is only out of a range that has a bound"),
            };
            return Err(format!("\"{}\" must be {range} (got {value}).", self.name));
        }
        self.dtype.cast(value).ok_or_else(|| {
            format!("{value} does not fit in {} (\"{}\").", self.dtype.as_str(), self.name)
        })
    }
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ProjectConfig {
    pub name: String,
    pub input_folder: Option<String>,      // None if images embedded
    /// Other paths the image folder is reached by, from other computers. See
    /// `commands::project::resolve_image_folder`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<String>>", optional)]
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
    /// Missing, as in projects from before regression existed, reads as off.
    #[serde(default)]
    #[ts(as = "Option<bool>", optional)]
    pub regression_enabled: bool,

    /// File extensions a folder scan takes (lowercase, no dot). Missing, as in
    /// projects from before it existed, reads as every supported format.
    #[serde(default = "default_extensions")]
    pub extensions: Vec<String>,
    /// An optional pattern file names must also match. Empty takes any name.
    pub input_regex: String,
    pub recursive: bool,
    #[ts(optional = nullable)]
    pub segmentation_labels: Option<Vec<LabelConfig>>,
    #[ts(optional = nullable)]
    pub classification_tasks: Option<Vec<MulticlassConfig>>,
    #[ts(optional = nullable)]
    pub multilabel_task: Option<MultilabelConfig>,
    #[ts(optional = nullable)]
    pub text_fields: Option<Vec<String>>,
    /// The numbers a frame can be given. Values are in the `regressions` table.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub regression_tasks: Option<Vec<RegressionConfig>>,
    pub folders_as_sequences: bool,
}

/// Image file extensions a folder scan can take.
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "bmp", "tif", "tiff", "webp"];

/// Microscopy file extensions, read through Bio-Formats: single-file formats
/// with an extension of their own (OME-TIFF goes with TIFF).
pub const MICROSCOPY_EXTENSIONS: &[&str] = &[
    "czi", "lif", "nd2", "lsm", "oib", "oif", "ims", "vsi", "svs", "ndpi", "scn", "bif", "dv",
    "r3d", "zvi", "dm3", "dm4", "stk",
];

/// Every extension a folder scan can take: images, videos, then microscopy.
pub fn default_extensions() -> Vec<String> {
    IMAGE_EXTENSIONS
        .iter()
        .chain(crate::video::EXTENSIONS)
        .chain(MICROSCOPY_EXTENSIONS)
        .map(|e| e.to_string())
        .collect()
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
            regression_enabled: false,
            extensions: default_extensions(),
            input_regex: String::from(".*"),
            recursive: false,
            segmentation_labels: None,
            classification_tasks: None,
            multilabel_task: None,
            text_fields: None,
            regression_tasks: None,
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
    fn a_config_without_extensions_takes_every_format() {
        let config: ProjectConfig = serde_json::from_str(&config_with("")).unwrap();
        assert_eq!(config.extensions, super::default_extensions());
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
    fn a_config_from_before_regression_has_none() {
        let config: ProjectConfig = serde_json::from_str(&config_with("")).unwrap();
        assert!(!config.regression_enabled);
        assert!(config.regression_tasks.is_none());
    }

    #[test]
    fn a_regression_task_defaults_to_an_unbounded_float32() {
        let task: super::RegressionConfig = serde_json::from_str(r#"{"name": "age"}"#).unwrap();
        assert_eq!(task.dtype, super::RegressionType::Float32);
        assert_eq!((task.min, task.max), (None, None));
        // Single precision: 0.1 is stored as the float32 nearest to it.
        assert_eq!(task.conform(0.1).unwrap(), 0.1f32 as f64);
        assert!(task.conform(f64::NAN).is_err());
        assert!(task.conform(1e300).is_err(), "too large for a float32");
    }

    #[test]
    fn a_regression_range_may_have_one_bound_and_includes_it() {
        let task: super::RegressionConfig =
            serde_json::from_str(r#"{"name": "age", "dtype": "int32", "min": 0}"#).unwrap();
        assert_eq!(task.conform(0.0).unwrap(), 0.0);
        assert_eq!(task.conform(41.6).unwrap(), 42.0, "an int32 is rounded");
        assert!(task.conform(-1.0).is_err());

        let bounded: super::RegressionConfig =
            serde_json::from_str(r#"{"name": "ef", "dtype": "float64", "min": 0, "max": 0.1}"#)
                .unwrap();
        assert_eq!(bounded.conform(0.1).unwrap(), 0.1);
        assert!(bounded.conform(0.11).is_err());
    }

    #[test]
    fn a_stored_embed_threshold_is_kept() {
        let config: ProjectConfig =
            serde_json::from_str(&config_with(r#""embed_threshold_kb": 250,"#)).unwrap();
        assert_eq!(config.embed_threshold_kb, 250);
    }
}
