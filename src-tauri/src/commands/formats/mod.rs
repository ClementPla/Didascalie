//! Pluggable import/export formats.
//!
//! Every format implements [`ExportFormat`] and/or [`ImportFormat`] against the
//! canonical [`Dataset`] IR and is listed in the registry below — adding a new
//! standard is one file plus one line. Formats describe their own options via
//! [`OptionSpec`], so the UI renders the export/import dialog generically with
//! no per-format code.

pub mod geometry;
pub mod storage;
pub mod masks;
pub mod coco;
pub mod yolo;

use serde::Serialize;
use std::path::Path;

use crate::types::dataset::Dataset;
use crate::utils::error::Result;

// ── Self-describing options ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OptionSpec {
    Bool { key: String, label: String, default: bool },
    Enum { key: String, label: String, choices: Vec<Choice>, default: String },
    Int { key: String, label: String, default: i64, min: i64, max: i64 },
}

#[derive(Debug, Clone, Serialize)]
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

/// Values chosen for a format's options — an untyped bag from the UI.
pub type OptionValues = serde_json::Map<String, serde_json::Value>;

pub fn get_bool(v: &OptionValues, key: &str, default: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(default)
}
pub fn get_str(v: &OptionValues, key: &str, default: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or(default).to_string()
}
pub fn get_int(v: &OptionValues, key: &str, default: i64) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(default)
}

/// A stable default label colour by index, for imports that carry no colours.
pub fn default_color(i: usize) -> String {
    const PALETTE: [&str; 10] = [
        "#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#46f0f0", "#f032e6", "#bcf60c",
        "#fabebe", "#008080",
    ];
    PALETTE[i % PALETTE.len()].to_string()
}

#[derive(Debug, Clone, Serialize, Default)]
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
    fn export(
        &self,
        dataset: &Dataset,
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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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
