// Format-agnostic representation of a project's annotations: importers
// produce a `Dataset`, exporters consume one. Only
// `commands::formats::storage` converts between it and SQLite.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Dataset {
    pub name: String,
    pub labels: Vec<LabelDef>,
    pub frames: Vec<FrameData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelDef {
    /// 1-based: the pixel value in label maps and the category id in object
    /// formats.
    pub index: u32,
    pub name: String,
    /// "#RRGGBB".
    pub color: String,
    pub is_instance: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FrameData {
    /// Relative to the dataset root. Names output files and matches imported
    /// annotations to images.
    pub relative_path: String,
    pub width: u32,
    pub height: u32,
    pub reviewed: bool,
    /// Per-label value masks. Polygons and boxes are derived from them by
    /// `formats::geometry`.
    pub label_masks: Vec<LabelMask>,
    /// Vector shapes, flattened to pixel-space polylines.
    pub shapes: Vec<PolygonShape>,
    pub classifications: Vec<Classification>,
    /// Embedded image bytes, when available.
    #[serde(skip)]
    pub image: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LabelMask {
    pub label_index: u32,
    /// `width*height`, row-major. 0 = background, otherwise the instance id (1
    /// for a semantic label).
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
    pub fn label(&self, index: u32) -> Option<&LabelDef> {
        self.labels.iter().find(|l| l.index == index)
    }
}
