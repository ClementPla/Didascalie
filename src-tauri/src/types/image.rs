use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum MaskEncoding {
    Rle,   // Legacy binary mask, RLE encoded (read-only for old files)
    Png,   // Legacy instance mask, RGBA PNG encoded (read-only for old files)
    Rle8,  // Value-aware RLE: 0 = bg, 1 = semantic, 1..=255 = instance id
}

impl MaskEncoding {
    pub fn as_str(&self) -> &'static str {
        match self {
            MaskEncoding::Rle => "rle",
            MaskEncoding::Png => "png",
            MaskEncoding::Rle8 => "rle8",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "png" => MaskEncoding::Png,
            "rle8" => MaskEncoding::Rle8,
            _ => MaskEncoding::Rle,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnnotationData {
    pub label_id: i64,
    pub label_name: String,
    pub color: String,
    pub encoding: MaskEncoding,
    pub mask_data: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationResponse {
    pub label_id: i64,
    pub label_name: String,
    pub color: String,
    /// Base64 of the raw `width*height` uint8 value mask (row-major).
    /// 0 = background, 1 = semantic label, 1..=255 = instance id.
    pub mask_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LabelId {
    pub id: i64,
    pub name: String,
}