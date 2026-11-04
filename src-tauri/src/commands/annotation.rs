use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use serde::{Serialize, Deserialize};
use ts_rs::TS;
use std::borrow::Cow;
use std::collections::HashMap;
use tauri::ipc::{InvokeBody, Request};
use tauri::State;
use crate::utils::error::{AppError, Result};
use crate::storage::{DbState, queries, rle};
use crate::types::image::{AnnotationResponse, MaskEncoding, LabelId};

/// Store one label's mask on a frame. The body is the mask already encoded as
/// `rle8` by the frontend (a full-size mask would cross the IPC as one JSON
/// number per pixel); `Frame-Id` and `Label-Id` headers say where it goes.
/// The legacy encodings (`rle`, instance `png`) are still read.
#[tauri::command]
pub fn save_annotation(db: State<DbState>, request: Request<'_>) -> Result<()> {
    let encoded = body_bytes(request.body())?;
    let encoded = encoded.as_ref();
    let header = |name: &str| -> Result<i64> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .ok_or_else(|| AppError::Other(format!("save_annotation needs a numeric {name} header")))
    };
    let (frame_id, label_id) = (header("frame-id")?, header("label-id")?);
    db.with_conn(|conn| {
        let (width, height) = queries::get_frame_dimensions(conn, frame_id)?;
        let pixels = width as u64 * height as u64;
        if rle::pixel_count8(encoded) != Some(pixels) {
            return Err(AppError::Other(format!(
                "The mask does not cover the {width}x{height} frame {frame_id}"
            )));
        }
        queries::save_annotation(conn, frame_id, label_id, encoded, MaskEncoding::Rle8)
    })
}

/// The bytes of a raw request body. On Android, Tauri sends every command
/// through `postMessage`, which turns a `Uint8Array` into a JSON array of
/// numbers; elsewhere the bytes arrive as they are.
fn body_bytes(body: &InvokeBody) -> Result<Cow<'_, [u8]>> {
    match body {
        InvokeBody::Raw(bytes) => Ok(Cow::Borrowed(bytes)),
        InvokeBody::Json(serde_json::Value::Array(values)) => values
            .iter()
            .map(|v| v.as_u64().and_then(|b| u8::try_from(b).ok()))
            .collect::<Option<Vec<u8>>>()
            .map(Cow::Owned)
            .ok_or_else(|| AppError::Other("save_annotation expects an array of bytes".into())),
        InvokeBody::Json(_) => {
            Err(AppError::Other("save_annotation expects the encoded mask as bytes".into()))
        }
    }
}

/// Erase every annotation on every frame of a sequence, returning how many
/// frames carried one. Not undoable.
#[tauri::command]
pub fn clear_sequence_annotations(db: State<DbState>, sequence_id: i64) -> Result<usize> {
    db.with_conn(|conn| queries::clear_sequence_annotations(conn, sequence_id))
}

#[tauri::command]
pub fn load_annotations(db: State<DbState>, frame_id: i64) -> Result<Vec<AnnotationResponse>> {
    db.with_conn(|conn| {
        let (width, height) = queries::get_frame_dimensions(conn, frame_id)?;
        let annotations = queries::load_annotations(conn, frame_id)?;

        annotations
            .into_iter()
            .map(|a| {
                // Stored as `rle8` already, except in older projects.
                let rle8 = match a.encoding {
                    MaskEncoding::Rle8 => a.mask_data,
                    ref legacy => rle::encode8(&decode_to_uint8(&a.mask_data, legacy, width, height)),
                };
                Ok(AnnotationResponse {
                    label_id: a.label_id,
                    label_name: a.label_name,
                    color: a.color,
                    rle8_base64: BASE64_STANDARD.encode(&rle8),
                    width,
                    height,
                })
            })
            .collect()
    })
}

/// Decode any stored encoding into a `width*height` uint8 value mask.
pub(crate) fn decode_to_uint8(data: &[u8], encoding: &MaskEncoding, width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    match encoding {
        MaskEncoding::Rle8 => rle::decode8(data, w, h),
        MaskEncoding::Rle => rle::decode(data, w, h)
            .into_iter()
            .map(|v| if v > 0 { 1 } else { 0 })
            .collect(),
        MaskEncoding::Png => decode_instance_png(data, w, h),
    }
}

/// Legacy instance masks were RGBA PNGs with one shade per instance: ids
/// (1..=255) are assigned to distinct opaque colours in order of appearance.
fn decode_instance_png(data: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut mask = vec![0u8; w * h];
    let img = match image::load_from_memory(data) {
        Ok(img) => img.to_rgba8(),
        Err(_) => return mask,
    };

    let mut ids: HashMap<[u8; 3], u8> = HashMap::new();
    let mut next_id: u8 = 1;
    for (i, px) in img.pixels().enumerate().take(mask.len()) {
        if px[3] == 0 {
            continue;
        }
        let key = [px[0], px[1], px[2]];
        let id = *ids.entry(key).or_insert_with(|| {
            let id = next_id;
            next_id = next_id.saturating_add(1);
            id
        });
        mask[i] = id;
    }
    mask
}

#[tauri::command]
pub fn list_labels(db: State<DbState>) -> Result<Vec<LabelId>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name FROM labels ORDER BY sort_order"
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(LabelId {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })?;

        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

#[derive(Serialize, Deserialize, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct LabelInfo {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub color: String,
    pub is_instance: bool,
    pub sort_order: i32,
}

#[tauri::command]
pub fn get_labels(db: State<DbState>) -> Result<Vec<LabelInfo>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, color, is_instance, sort_order FROM labels ORDER BY sort_order"
        )?;
        
        let labels = stmt.query_map([], |row| {
            Ok(LabelInfo {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_instance: row.get(3)?,
                sort_order: row.get(4)?,
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
        
        Ok(labels)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn body_bytes_takes_raw_and_android_json() {
        let raw = InvokeBody::Raw(vec![0, 7, 255]);
        assert_eq!(body_bytes(&raw).unwrap().as_ref(), &[0, 7, 255]);

        // What Android's postMessage turns a Uint8Array into.
        let android = InvokeBody::Json(json!([0, 7, 255]));
        assert_eq!(body_bytes(&android).unwrap().as_ref(), &[0, 7, 255]);

        assert!(body_bytes(&InvokeBody::Json(json!([256]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(json!([-1]))).is_err());
        assert!(body_bytes(&InvokeBody::Json(json!({ "frameId": 1 }))).is_err());
    }
}
