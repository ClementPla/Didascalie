use std::collections::HashMap;

use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::storage::DbState;
use crate::utils::error::{AppError, Result};

// ==========================================
// Types
// ==========================================

#[derive(Serialize, Debug)]
pub struct Sequence {
    pub id: i64,
    pub name: String,
    pub frame_count: i64,
    pub sort_order: i32,
}

#[derive(Serialize, Debug)]
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

// ==========================================
// Commands
// ==========================================

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

/// Get a single sequence by ID
#[tauri::command]
pub fn get_sequence(db: State<DbState>, sequence_id: i64) -> Result<Sequence> {
    db.with_conn(|conn| {
        let sequence = conn.query_row(
            "SELECT 
                s.id, 
                s.name, 
                s.sort_order,
                COUNT(f.id) as frame_count
             FROM sequences s
             LEFT JOIN frames f ON f.sequence_id = s.id
             WHERE s.id = ?1
             GROUP BY s.id",
            params![sequence_id],
            |row| {
                Ok(Sequence {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                    frame_count: row.get(3)?,
                })
            },
        ).map_err(|e| AppError::Database(e))?;

        Ok(sequence)
    })
}

#[derive(Debug, Serialize)]
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
                SUM(CASE WHEN f.reviewed THEN 1 ELSE 0 END) as reviewed_count,
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
                reviewed,
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

/// Create a new sequence
#[tauri::command]
pub fn create_sequence(
    db: State<DbState>,
    name: String,
    sort_order: Option<i32>,
) -> Result<i64> {
    db.with_conn(|conn| {
        let order = sort_order.unwrap_or_else(|| {
            // Get next sort order
            conn.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM sequences",
                [],
                |row| row.get(0),
            ).unwrap_or(0)
        });

        conn.execute(
            "INSERT INTO sequences (name, sort_order) VALUES (?1, ?2)",
            params![name, order],
        ).map_err(|e| AppError::Database(e))?;

        Ok(conn.last_insert_rowid())
    })
}

/// Rename a sequence
#[tauri::command]
pub fn rename_sequence(
    db: State<DbState>,
    sequence_id: i64,
    new_name: String,
) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE sequences SET name = ?1 WHERE id = ?2",
            params![new_name, sequence_id],
        ).map_err(|e| AppError::Database(e))?;

        Ok(())
    })
}

/// Delete a sequence and all its frames
#[tauri::command]
pub fn delete_sequence(db: State<DbState>, sequence_id: i64) -> Result<()> {
    db.with_conn(|conn| {
        // Frames are deleted automatically via ON DELETE CASCADE
        conn.execute(
            "DELETE FROM sequences WHERE id = ?1",
            params![sequence_id],
        ).map_err(|e| AppError::Database(e))?;

        Ok(())
    })
}

/// Reorder sequences
#[tauri::command]
pub fn reorder_sequences(
    db: State<DbState>,
    sequence_ids: Vec<i64>,
) -> Result<()> {
    db.with_conn(|conn| {
        for (index, id) in sequence_ids.iter().enumerate() {
            conn.execute(
                "UPDATE sequences SET sort_order = ?1 WHERE id = ?2",
                params![index as i32, id],
            ).map_err(|e| AppError::Database(e))?;
        }

        Ok(())
    })
}

/// Get sequence by name
#[tauri::command]
pub fn find_sequence_by_name(
    db: State<DbState>,
    name: String,
) -> Result<Option<Sequence>> {
    db.with_conn(|conn| {
        let result = conn.query_row(
            "SELECT 
                s.id, 
                s.name, 
                s.sort_order,
                COUNT(f.id) as frame_count
             FROM sequences s
             LEFT JOIN frames f ON f.sequence_id = s.id
             WHERE s.name = ?1
             GROUP BY s.id",
            params![name],
            |row| {
                Ok(Sequence {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    sort_order: row.get(2)?,
                    frame_count: row.get(3)?,
                })
            },
        );

        match result {
            Ok(seq) => Ok(Some(seq)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(AppError::Database(e)),
        }
    })
}

/// Move frames between sequences
#[tauri::command]
pub fn move_frames_to_sequence(
    db: State<DbState>,
    frame_ids: Vec<i64>,
    target_sequence_id: i64,
) -> Result<()> {
    db.with_conn(|conn| {
        // Get the next frame_index in target sequence
        let mut next_index: i32 = conn.query_row(
            "SELECT COALESCE(MAX(frame_index), -1) + 1 FROM frames WHERE sequence_id = ?1",
            params![target_sequence_id],
            |row| row.get(0),
        ).map_err(|e| AppError::Database(e))?;

        // Move each frame
        for frame_id in frame_ids {
            conn.execute(
                "UPDATE frames SET sequence_id = ?1, frame_index = ?2 WHERE id = ?3",
                params![target_sequence_id, next_index, frame_id],
            ).map_err(|e| AppError::Database(e))?;
            
            next_index += 1;
        }

        Ok(())
    })
}