//! Pluggable import/export formats.
//!
//! A format implements [`ExportFormat`] and/or [`ImportFormat`] against the
//! [`Dataset`] IR and is listed in the registry below. Formats describe their
//! options with [`OptionSpec`], which the UI renders generically.

pub mod geometry;
pub mod storage;
pub mod masks;
pub mod coco;
pub mod yolo;

use ts_rs::TS;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

use crate::types::dataset::{Dataset, DatasetInfo, FrameSource};
use crate::utils::error::Result;
use crate::utils::AppError;
use std::fs;

// ── Self-describing options ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "FormatOption")]
pub enum OptionSpec {
    Bool { key: String, label: String, default: bool },
    Enum { key: String, label: String, choices: Vec<Choice>, default: String },
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "FormatChoice")]
pub struct Choice {
    pub value: String,
    pub label: String,
}

pub fn bool_opt(key: &str, label: &str, default: bool) -> OptionSpec {
    OptionSpec::Bool { key: key.into(), label: label.into(), default }
}
pub fn enum_opt(key: &str, label: &str, choices: &[(&str, &str)], default: &str) -> OptionSpec {
    OptionSpec::Enum {
        key: key.into(),
        label: label.into(),
        choices: choices.iter().map(|(v, l)| Choice { value: v.to_string(), label: l.to_string() }).collect(),
        default: default.into(),
    }
}

/// Values chosen for a format's options.
pub type OptionValues = serde_json::Map<String, serde_json::Value>;

pub fn get_bool(v: &OptionValues, key: &str, default: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(default)
}
pub fn get_str(v: &OptionValues, key: &str, default: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or(default).to_string()
}

/// `rel` reduced to its plain components, so joining it onto an export folder
/// can never land outside it: `..`, roots and drive prefixes are dropped.
/// Frame paths come from the project, and through imports from foreign
/// files, so they are not trusted. Empty results become `fallback`.
pub fn contained_path(rel: &str, fallback: &str) -> PathBuf {
    let clean: PathBuf = Path::new(rel)
        .components()
        .filter_map(|c| match c {
            Component::Normal(part) => Some(part),
            _ => None,
        })
        .collect();
    if clean.as_os_str().is_empty() {
        PathBuf::from(fallback)
    } else {
        clean
    }
}

/// `name` made safe as a single path component (a label name used as a
/// folder): separators become `_`, and `.`/`..`/empty become `fallback`.
pub fn component_name(name: &str, fallback: &str) -> String {
    let cleaned: String =
        name.chars().map(|c| if c == '/' || c == '\\' || c == '\0' { '_' } else { c }).collect();
    match cleaned.trim() {
        "" | "." | ".." => fallback.to_string(),
        _ => cleaned,
    }
}

/// Create `path`'s parent folder, then write `bytes` to it.
pub fn write_file(path: &Path, bytes: impl AsRef<[u8]>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Generic(format!("create {}: {e}", parent.display())))?;
    }
    fs::write(path, bytes).map_err(|e| AppError::Generic(format!("write {}: {e}", path.display())))
}

/// A default label colour by index, for imports that carry none.
pub fn default_color(i: usize) -> String {
    const PALETTE: [&str; 10] = [
        "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c",
        "#fabebe", "#008080",
    ];
    PALETTE[i % PALETTE.len()].to_string()
}

#[derive(Debug, Clone, Serialize, Default, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "FormatCapabilities")]
pub struct Capabilities {
    pub masks: bool,
    pub polygons: bool,
    pub bboxes: bool,
    pub classifications: bool,
    pub instances: bool,
}

/// Progress callback: `(done, total, current_label)`.
pub type Progress<'a> = dyn FnMut(u32, u32, &str) + 'a;

// ── Traits ──────────────────────────────────────────────────────────────────

pub trait ExportFormat: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn description(&self) -> &str {
        ""
    }
    fn capabilities(&self) -> Capabilities;
    fn options(&self) -> Vec<OptionSpec> {
        Vec::new()
    }
    /// Whether this export, with `opts`, writes the embedded image files: if
    /// not, they are not read at all.
    fn wants_images(&self, _opts: &OptionValues) -> bool {
        false
    }
    fn export(
        &self,
        dataset: &DatasetInfo,
        frames: &mut dyn FrameSource,
        out_dir: &Path,
        opts: &OptionValues,
        progress: &mut Progress,
    ) -> Result<()>;
}

pub trait ImportFormat: Send + Sync {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
    fn description(&self) -> &str {
        ""
    }
    fn options(&self) -> Vec<OptionSpec> {
        Vec::new()
    }
    fn import(
        &self,
        path: &Path,
        opts: &OptionValues,
        progress: &mut Progress,
    ) -> Result<Dataset>;
}

#[cfg(test)]
mod path_tests {
    use super::*;

    #[test]
    fn contained_path_drops_escaping_components() {
        assert_eq!(contained_path("../../evil.png", "f"), PathBuf::from("evil.png"));
        assert_eq!(contained_path("/etc/passwd", "f"), PathBuf::from("etc/passwd"));
        assert_eq!(contained_path("a/./b/../c.png", "f"), PathBuf::from("a/b/c.png"));
        assert_eq!(contained_path("..", "f"), PathBuf::from("f"));
        assert_eq!(contained_path("", "f"), PathBuf::from("f"));
    }

    #[test]
    fn component_name_is_one_component() {
        assert_eq!(component_name("a/b", "x"), "a_b");
        assert_eq!(component_name("..", "x"), "x");
        assert_eq!(component_name("Cell", "x"), "Cell");
    }
}

// ── Registry ────────────────────────────────────────────────────────────────

pub fn export_formats() -> Vec<Box<dyn ExportFormat>> {
    vec![Box::new(masks::Masks), Box::new(coco::Coco), Box::new(yolo::Yolo)]
}

pub fn import_formats() -> Vec<Box<dyn ImportFormat>> {
    vec![Box::new(coco::Coco), Box::new(yolo::Yolo)]
}

pub fn find_exporter(id: &str) -> Option<Box<dyn ExportFormat>> {
    export_formats().into_iter().find(|f| f.id() == id)
}
pub fn find_importer(id: &str) -> Option<Box<dyn ImportFormat>> {
    import_formats().into_iter().find(|f| f.id() == id)
}

/// UI metadata: one entry per format id, merging its export/import sides.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/", rename = "DatasetFormat")]
pub struct FormatInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub can_export: bool,
    pub can_import: bool,
    pub export_options: Vec<OptionSpec>,
    pub import_options: Vec<OptionSpec>,
    pub capabilities: Capabilities,
}

pub fn format_infos() -> Vec<FormatInfo> {
    let mut infos: Vec<FormatInfo> = Vec::new();

    for f in export_formats() {
        infos.push(FormatInfo {
            id: f.id().to_string(),
            name: f.name().to_string(),
            description: f.description().to_string(),
            can_export: true,
            can_import: false,
            export_options: f.options(),
            import_options: Vec::new(),
            capabilities: f.capabilities(),
        });
    }
    for f in import_formats() {
        if let Some(existing) = infos.iter_mut().find(|i| i.id == f.id()) {
            existing.can_import = true;
            existing.import_options = f.options();
        } else {
            infos.push(FormatInfo {
                id: f.id().to_string(),
                name: f.name().to_string(),
                description: f.description().to_string(),
                can_export: false,
                can_import: true,
                export_options: Vec::new(),
                import_options: f.options(),
                capabilities: Capabilities::default(),
            });
        }
    }
    infos
}
