use base64::Engine;
use base64::prelude::BASE64_STANDARD;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use tauri::State;
use crate::utils::error::Result;
use crate::storage::{DbState, queries, rle};
use crate::types::image::{AnnotationResponse, MaskEncoding, LabelId};

#[tauri::command]
pub fn save_annotation(
    db: State<DbState>,
    frame_id: i64,
    label_id: i64,
    mask_data: Vec<u8>,
) -> Result<()> {
    // Always written as `rle8`. The legacy encodings (`rle`, instance `png`) are
    // still read.
    db.with_conn(|conn| {
        let encoded = rle::encode8(&mask_data);
        queries::save_annotation(conn, frame_id, label_id, &encoded, MaskEncoding::Rle8)
    })
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
                let mask = decode_to_uint8(&a.mask_data, &a.encoding, width, height);
                Ok(AnnotationResponse {
                    label_id: a.label_id,
                    label_name: a.label_name,
                    color: a.color,
                    mask_base64: BASE64_STANDARD.encode(&mask),
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

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LabelInfo {
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