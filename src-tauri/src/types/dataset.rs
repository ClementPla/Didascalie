// Canonical, format-agnostic representation of a project's annotations.
//
// This is the hub of the import/export system: importers produce a `Dataset`,
// exporters consume one. Storage <-> `Dataset` is a single adapter
// (`commands::formats::storage`), and every file format only ever talks to this
// IR — so a new format never touches SQLite or any other format.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Dataset {
    pub name: String,
    pub labels: Vec<LabelDef>,
    pub frames: Vec<FrameData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelDef {
    /// 1-based index, used as the pixel value in label maps and the category id
    /// in object formats. Stable within an export.
    pub index: u32,
    pub name: String,
    /// "#RRGGBB".
    pub color: String,
    pub is_instance: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FrameData {
    /// Path relative to the dataset root, used for output file naming and to
    /// match imported annotations back to images.
    pub relative_path: String,
    pub width: u32,
    pub height: u32,
    pub reviewed: bool,
    /// Per-label value masks (the source of truth from storage). A format that
    /// wants polygons/boxes derives them via `formats::geometry`.
    pub label_masks: Vec<LabelMask>,
    /// Vector shapes (already flattened to pixel-space polylines).
    pub shapes: Vec<PolygonShape>,
    pub classifications: Vec<Classification>,
    /// Embedded image bytes when available (skipped in JSON round-trips).
    #[serde(skip)]
    pub image: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelMask {
    pub label_index: u32,
    /// `width*height`, row-major. 0 = background, otherwise the instance id
    /// (always 1 for a semantic label).
    pub values: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolygonShape {
    pub label_index: u32,
    pub closed: bool,
    pub filled: bool,
    /// Outline in image-pixel coordinates.
    pub points: Vec<[f64; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classification {
    pub task: String,
    pub values: Vec<String>,
}

impl Dataset {
    /// Look up a label by its 1-based index.
    pub fn label(&self, index: u32) -> Option<&LabelDef> {
        self.labels.iter().find(|l| l.index == index)
    }
}
