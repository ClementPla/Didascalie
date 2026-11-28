use ts_rs::TS;
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

    /// The encoding named by a stored `encoding` column. Unknown names are an
    /// error: decoding them as one of these would yield a garbage mask.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "rle" => Ok(MaskEncoding::Rle),
            "png" => Ok(MaskEncoding::Png),
            "rle8" => Ok(MaskEncoding::Rle8),
            other => Err(format!("unknown mask encoding \"{other}\"")),
        }
    }

    /// [`Self::parse`] for a column read inside a rusqlite row closure.
    pub fn from_column(s: &str, column: usize) -> rusqlite::Result<Self> {
        Self::parse(s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(column, rusqlite::types::Type::Text, e.into())
        })
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

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct AnnotationResponse {
    #[ts(type = "number")]
    pub label_id: i64,
    pub label_name: String,
    pub color: String,
    /// Base64 of the mask encoded as `rle8` (see `storage::rle`): decoded, a
    /// `width*height` uint8 value mask, row-major, 0 = background,
    /// 1 = semantic label, 1..=255 = instance id. Encoded, it is a few
    /// kilobytes where the mask would be one byte per pixel.
    pub rle8_base64: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct LabelId {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
}