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

/// Copy one decoded mask into its slice of the volume.
///
/// Both length mismatches are tolerated rather than fatal, because a volume is
/// assembled from per-frame annotations that were written independently: a mask
/// shorter than the slice leaves the remainder zero (the buffer starts zeroed),
/// and a longer one is truncated. Silently, in both directions — a ragged
/// annotation should not fail a whole sequence load, and the frame dimensions
/// were already checked by `volume_dimensions`.
fn write_slice(out: &mut [u8], mask: &[u8]) {
    let n = mask.len().min(out.len());
    out[..n].copy_from_slice(&mask[..n]);
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
                write_slice(out, &decode_to_uint8(data, encoding, w, h));
            }
        });

    Ok(Response::new(volume))
}


#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Just the `frames` columns `get_frame_dimensions` reads — the migration
    /// helpers are private to `storage::queries`, and a volume's dimension rule
    /// does not depend on the rest of the schema.
    fn db_with_frames(frames: &[(i64, u32, u32)]) -> DbState {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE frames (id INTEGER PRIMARY KEY, width INTEGER, height INTEGER);",
        )
        .unwrap();
        for (id, w, h) in frames {
            conn.execute(
                "INSERT INTO frames (id, width, height) VALUES (?1, ?2, ?3)",
                params![id, w, h],
            )
            .unwrap();
        }
        let db = DbState::new();
        db.set(conn);
        db
    }

    #[test]
    fn uniform_frames_share_one_size() {
        let db = db_with_frames(&[(1, 8, 4), (2, 8, 4), (3, 8, 4)]);
        assert_eq!(volume_dimensions(&db, &[1, 2, 3]).unwrap(), (8, 4));
    }

    #[test]
    fn a_ragged_frame_is_rejected_and_named() {
        // The whole point of the check: stacking a differently sized slice would
        // silently shear every voxel after it.
        let db = db_with_frames(&[(1, 8, 4), (2, 8, 5)]);
        let err = volume_dimensions(&db, &[1, 2]).unwrap_err();
        assert!(err.contains('2'), "error should name the offending frame: {err}");
        assert!(err.contains("8×4"), "error should state the expected size: {err}");
    }

    #[test]
    fn an_empty_volume_is_rejected() {
        let db = db_with_frames(&[]);
        assert!(volume_dimensions(&db, &[]).is_err());
    }

    #[test]
    fn a_short_mask_leaves_the_rest_of_the_slice_zero() {
        let mut out = vec![0u8; 6];
        write_slice(&mut out, &[1, 2, 3]);
        assert_eq!(out, vec![1, 2, 3, 0, 0, 0]);
    }

    #[test]
    fn a_long_mask_is_truncated_to_the_slice() {
        let mut out = vec![0u8; 3];
        write_slice(&mut out, &[1, 2, 3, 4, 5]);
        assert_eq!(out, vec![1, 2, 3]);
    }

    #[test]
    fn writing_a_slice_does_not_touch_its_neighbours() {
        // par_chunks_mut hands each slice a disjoint window; prove the helper
        // stays inside the one it was given.
        let mut volume = vec![0u8; 9];
        {
            let (_, rest) = volume.split_at_mut(3);
            let (middle, _) = rest.split_at_mut(3);
            write_slice(middle, &[7, 7, 7]);
        }
        assert_eq!(volume, vec![0, 0, 0, 7, 7, 7, 0, 0, 0]);
    }
}
