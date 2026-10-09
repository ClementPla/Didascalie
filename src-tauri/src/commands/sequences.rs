use std::collections::HashMap;

use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::storage::DbState;
use crate::utils::error::{AppError, Result};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub id: i64,
    pub name: String,
    pub frame_count: i64,
    pub sort_order: i32,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub id: i64,
    pub sequence_id: i64,
    pub frame_index: i32,
    pub relative_path: Option<String>,
    pub width: i32,
    pub height: i32,
    pub reviewed: bool,
    pub is_embedded: bool,
}

// ── Commands ───────────────────────────────────────────────────────────────

/// List all sequences with frame counts
#[tauri::command]
pub fn list_sequences(db: State<DbState>) -> Result<Vec<Sequence>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT 
                s.id, 
                s.name, 
                s.sort_order,
                COUNT(f.id) as frame_count
             FROM sequences s
             LEFT JOIN frames f ON f.sequence_id = s.id
             GROUP BY s.id
             ORDER BY s.sort_order, s.name"
        ).map_err(|e| AppError::Database(e))?;

        let rows = stmt.query_map([], |row| {
            Ok(Sequence {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
                frame_count: row.get(3)?,
            })
        }).map_err(|e| AppError::Database(e))?;

        let sequences: Vec<Sequence> = rows
            .filter_map(|r| r.ok())
            .collect();

        Ok(sequences)
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GallerySequence {
    pub id: i64,
    pub name: String,
    pub sort_order: i64,
    pub frame_count: i64,
    pub reviewed_count: i64,
    /// Number of frames that have at least one annotation (raster mask or vector
    /// shape). Drives the "in progress" status independent of review.
    pub annotated_count: i64,
    pub first_frame_id: Option<i64>,
    /// True if any registration in this sequence has at least one keypoint pair,
    /// regardless of which frame pair it belongs to.
    pub has_keypoints: bool,
}

#[tauri::command]
pub fn get_gallery_sequences(db: State<DbState>) -> Result<Vec<GallerySequence>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT 
                s.id,
                s.name,
                s.sort_order,
                COUNT(f.id) as frame_count,
                COUNT(DISTINCT CASE
                    WHEN EXISTS (SELECT 1 FROM frame_reviews fr WHERE fr.frame_id = f.id)
                    THEN f.id END) as reviewed_count,
                COUNT(DISTINCT CASE
                    WHEN EXISTS (SELECT 1 FROM annotations a WHERE a.frame_id = f.id)
                      OR EXISTS (SELECT 1 FROM vector_annotations v WHERE v.frame_id = f.id)
                    THEN f.id END) as annotated_count,
                MIN(f.id) as first_frame_id,
                EXISTS (
                    SELECT 1
                    FROM registrations r
                    JOIN keypoint_pairs kp ON kp.registration_id = r.id
                    WHERE r.sequence_id = s.id
                ) as has_keypoints
             FROM sequences s
             LEFT JOIN frames f ON f.sequence_id = s.id
             GROUP BY s.id
             ORDER BY s.sort_order"
        ).map_err(|e| AppError::Database(e))?;
        
        let rows = stmt.query_map([], |row| {
            Ok(GallerySequence {
                id: row.get(0)?,
                name: row.get(1)?,
                sort_order: row.get(2)?,
                frame_count: row.get(3)?,
                reviewed_count: row.get(4)?,
                annotated_count: row.get(5)?,
                first_frame_id: row.get(6)?,
                has_keypoints: row.get(7)?,
            })
        }).map_err(|e| AppError::Database(e))?;
        
        let sequences: Vec<GallerySequence> = rows
            .filter_map(|r| r.ok())
            .collect();
        
        Ok(sequences)
    })
}

#[tauri::command]
pub fn get_all_frame_ids_by_sequence(db: State<DbState>) -> Result<HashMap<i64, Vec<i64>>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT sequence_id, id FROM frames ORDER BY sequence_id, frame_index"
        ).map_err(|e| AppError::Database(e))?;
        
        let mut result: HashMap<i64, Vec<i64>> = HashMap::new();
        
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| AppError::Database(e))?;
        
        for row in rows.flatten() {
            result.entry(row.0).or_default().push(row.1);
        }
        
        Ok(result)
    })
}

/// Get all frames for a sequence
#[tauri::command]
pub fn get_sequence_frames(db: State<DbState>, sequence_id: i64) -> Result<Vec<Frame>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT 
                id, 
                sequence_id, 
                frame_index, 
                relative_path,
                width, 
                height, 
                EXISTS (SELECT 1 FROM frame_reviews r WHERE r.frame_id = frames.id),
                embedded_data IS NOT NULL as is_embedded
             FROM frames 
             WHERE sequence_id = ?1
             ORDER BY frame_index"
        ).map_err(|e| AppError::Database(e))?;

        let rows = stmt.query_map(params![sequence_id], |row| {
            Ok(Frame {
                id: row.get(0)?,
                sequence_id: row.get(1)?,
                frame_index: row.get(2)?,
                relative_path: row.get(3)?,
                width: row.get(4)?,
                height: row.get(5)?,
                reviewed: row.get(6)?,
                is_embedded: row.get(7)?,
            })
        }).map_err(|e| AppError::Database(e))?;

        let frames: Vec<Frame> = rows
            .filter_map(|r| r.ok())
            .collect();

        Ok(frames)
    })
}
