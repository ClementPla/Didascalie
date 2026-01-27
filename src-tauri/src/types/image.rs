use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub enum MaskEncoding {
    Rle,   // Binary mask, RLE encoded
    Png,   // Instance mask or fallback, PNG encoded
}

impl MaskEncoding {
    pub fn as_str(&self) -> &'static str {
        match self {
            MaskEncoding::Rle => "rle",
            MaskEncoding::Png => "png",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "png" => MaskEncoding::Png,
            _ => MaskEncoding::Rle,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageInfo {
    pub id: i64,
    pub relative_path: String,
    pub content_hash: Option<String>,
    pub width: u32,
    pub height: u32,
    pub frame_group: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageWithData {
    pub info: ImageInfo,
    pub data_base64: String,  // For frontend display
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AnnotationData {
    pub label_id: i64,
    pub label_name: String,
    pub color: String,
    pub encoding: MaskEncoding,
    pub mask_data: Vec<u8>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageAnnotations {
    pub image_id: i64,
    pub annotations: Vec<AnnotationData>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationResponse {
    pub label_id: i64,
    pub label_name: String,
    pub color: String,
    pub mask_png_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LabelId {
    pub id: i64,
    pub name: String,
}