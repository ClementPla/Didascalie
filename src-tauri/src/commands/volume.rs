//! Whole-sequence reads for the editor's 3D (volume) mode.
//!
//! In 3D mode the frontend keeps every frame of a sequence resident as a
//! `W×H×D` volume (frames stacked along Z, the slowest axis), so scrolling
//! slices and rebuilding the 3D views never round-trips per frame. These
//! commands fill that volume in one call each: the frames' pixels as 8-bit
//! luminance, and one label's masks. Both return raw bytes (`Response`), never
//! JSON, since a volume is tens to hundreds of MB.
//!
//! The caller passes the frame ids in display order, so the Z axis matches the
//! editor's frame index without a second lookup. Every frame must share the
//! first frame's size — a volume with ragged slices has no meaning.

use rayon::prelude::*;
use rusqlite::{params, OptionalExtension};
use tauri::ipc::Response;
use tauri::State;

use crate::commands::annotation::decode_to_uint8;
use crate::commands::frame::read_frame_bytes;
use crate::storage::{queries, DbState};
use crate::types::image::MaskEncoding;

/// The shared `(width, height)` of `frame_ids`, or an error naming the first
/// frame that differs.
fn volume_dimensions(db: &DbState, frame_ids: &[i64]) -> Result<(u32, u32), String> {
    let first = *frame_ids
        .first()
        .ok_or("A volume needs at least one frame")?;
    db.with_conn(|conn| {
        let dims = queries::get_frame_dimensions(conn, first)?;
        for &id in &frame_ids[1..] {
            if queries::get_frame_dimensions(conn, id)? != dims {
                return Err(crate::utils::error::AppError::Generic(format!(
                    "Frame {} is not {}×{}; every slice of a volume must share one size",
                    id, dims.0, dims.1
                )));
            }
        }
        Ok(dims)
    })
    .map_err(|e| e.to_string())
}

/// Every frame's pixels as 8-bit luminance, concatenated in `frame_ids` order
/// (`W*H*D` bytes). Colour frames are converted to luma; 16-bit ones are
/// rescaled to 8 bits.
#[tauri::command]
pub async fn load_sequence_image_volume(
    db: State<'_, DbState>,
    frame_ids: Vec<i64>,
) -> Result<Response, String> {
    let (w, h) = volume_dimensions(&db, &frame_ids)?;
    let slice = (w as usize) * (h as usize);

    // Reading is serialised by the connection lock; decoding is the expensive
    // part, so gather the encoded bytes first and decode them in parallel.
    let encoded: Vec<Vec<u8>> = frame_ids
        .iter()
        .map(|&id| read_frame_bytes(&db, id).map(|(_, bytes)| bytes))
        .collect::<crate::utils::error::Result<_>>()
        .map_err(|e| e.to_string())?;

    let mut volume = vec![0u8; slice * frame_ids.len()];
    volume
        .par_chunks_mut(slice)
        .zip(encoded.par_iter())
        .try_for_each(|(out, bytes)| -> Result<(), String> {
            let luma = image::load_from_memory(bytes)
                .map_err(|e| format!("Failed to decode image: {}", e))?
                .to_luma8();
            if luma.width() != w || luma.height() != h {
                return Err(format!(
                    "Decoded image is {}×{}, but its frame is recorded as {}×{}",
                    luma.width(),
                    luma.height(),
                    w,
                    h
                ));
            }
            out.copy_from_slice(luma.as_raw());
            Ok(())
        })?;

    Ok(Response::new(volume))
}

/// One label's masks for every frame, concatenated in `frame_ids` order
/// (`W*H*D` bytes, uint8 values as in the editor). A frame with no annotation
/// for the label contributes a zero slice.
#[tauri::command]
pub async fn load_label_volume(
    db: State<'_, DbState>,
    frame_ids: Vec<i64>,
    label_id: i64,
) -> Result<Response, String> {
    let (w, h) = volume_dimensions(&db, &frame_ids)?;
    let slice = (w as usize) * (h as usize);

    let encoded: Vec<Option<(MaskEncoding, Vec<u8>)>> = db
        .with_conn(|conn| {
            let mut stmt = conn.prepare_cached(
                "SELECT encoding, mask_data FROM annotations
                 WHERE frame_id = ?1 AND label_id = ?2",
            )?;
            let mut rows = Vec::with_capacity(frame_ids.len());
            for &frame_id in &frame_ids {
                let row = stmt
                    .query_row(params![frame_id, label_id], |row| {
                        Ok((
                            MaskEncoding::from_str(&row.get::<_, String>(0)?),
                            row.get::<_, Vec<u8>>(1)?,
                        ))
                    })
                    .optional()?;
                rows.push(row);
            }
            Ok(rows)
        })
        .map_err(|e| e.to_string())?;

    let mut volume = vec![0u8; slice * frame_ids.len()];
    volume
        .par_chunks_mut(slice)
        .zip(encoded.par_iter())
        .for_each(|(out, row)| {
            if let Some((encoding, data)) = row {
                let mask = decode_to_uint8(data, encoding, w, h);
                let n = mask.len().min(out.len());
                out[..n].copy_from_slice(&mask[..n]);
            }
        });

    Ok(Response::new(volume))
}
