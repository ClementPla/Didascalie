use std::collections::HashMap;

use rusqlite::params;
use serde::Serialize;
use ts_rs::TS;
use tauri::State;

use crate::commands::frame::Frame;
use crate::storage::{queries, DbState};
use crate::utils::error::{AppError, Result};

// ── Types ──────────────────────────────────────────────────────────────────

#[derive(Serialize, Debug, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct Sequence {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    #[ts(type = "number")]
    pub frame_count: i64,
    pub sort_order: i32,
}


// ── Commands ───────────────────────────────────────────────────────────────

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

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct GallerySequence {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    #[ts(type = "number")]
    pub sort_order: i64,
    #[ts(type = "number")]
    pub frame_count: i64,
    #[ts(type = "number")]
    pub reviewed_count: i64,
    /// Frames with at least one annotation (raster mask or vector shape).
    #[ts(type = "number")]
    pub annotated_count: i64,
    #[ts(type = "number | null")]
    pub first_frame_id: Option<i64>,
    /// Any registration of this sequence has at least one keypoint pair.
    pub has_keypoints: bool,
}

#[tauri::command]
pub fn get_gallery_sequences(db: State<DbState>) -> Result<Vec<GallerySequence>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(&format!(
            "SELECT 
                s.id,
                s.name,
                s.sort_order,
                COUNT(f.id) as frame_count,
                COUNT(DISTINCT CASE
                    WHEN EXISTS (SELECT 1 FROM frame_reviews fr WHERE fr.frame_id = f.id)
                    THEN f.id END) as reviewed_count,
                COUNT(DISTINCT CASE
                    WHEN {}
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
             ORDER BY s.sort_order",
            queries::FRAME_HAS_ANNOTATION
        )).map_err(|e| AppError::Database(e))?;
        
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

/// How a sequence was answered, for the gallery to filter and sort by. Only
/// the current user's answers.
#[derive(Debug, Default, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct SequenceAnswers {
    #[ts(type = "number")]
    pub sequence_id: i64,
    /// Classification task -> the classes at least one frame was given,
    /// sorted by name.
    pub classes: HashMap<String, Vec<String>>,
    /// Regression task -> the mean of the values its frames were given.
    pub regressions: HashMap<String, f64>,
}

/// The classification and regression answers of every sequence that has some.
#[tauri::command]
pub fn get_gallery_answers(db: State<DbState>) -> Result<Vec<SequenceAnswers>> {
    db.with_conn(gallery_answers)
}

fn gallery_answers(conn: &rusqlite::Connection) -> Result<Vec<SequenceAnswers>> {
    type BySequence = std::collections::BTreeMap<i64, SequenceAnswers>;
    fn entry(by_sequence: &mut BySequence, sequence_id: i64) -> &mut SequenceAnswers {
        by_sequence
            .entry(sequence_id)
            .or_insert_with(|| SequenceAnswers { sequence_id, ..Default::default() })
    }
    let mut by_sequence = BySequence::new();

    {
        let mut stmt = conn.prepare(
            "SELECT DISTINCT f.sequence_id, c.task_name, c.selected_classes
             FROM classifications c
             JOIN frames f ON f.id = c.frame_id",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        for row in rows {
            let (sequence_id, task, json) = row?;
            let selected: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
            let classes = entry(&mut by_sequence, sequence_id).classes.entry(task).or_default();
            for class in selected {
                if !classes.contains(&class) {
                    classes.push(class);
                }
            }
        }
    }

    {
        let mut stmt = conn.prepare(
            "SELECT f.sequence_id, r.task_name, AVG(r.value)
             FROM regressions r
             JOIN frames f ON f.id = r.frame_id
             GROUP BY f.sequence_id, r.task_name",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?))
        })?;
        for row in rows {
            let (sequence_id, task, mean) = row?;
            entry(&mut by_sequence, sequence_id).regressions.insert(task, mean);
        }
    }

    let mut answers: Vec<SequenceAnswers> = by_sequence.into_values().collect();
    for sequence in &mut answers {
        for classes in sequence.classes.values_mut() {
            classes.sort();
        }
    }
    Ok(answers)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Sequence 1 has frames 1 and 2, sequence 2 has frame 3, sequence 3 has
    /// frame 4 and no answer.
    fn fixture() -> rusqlite::Connection {
        let conn = queries::create_database(std::path::Path::new(":memory:")).unwrap();
        queries::install_user_scope(&conn).unwrap();
        crate::commands::users::auto_login(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c');
             INSERT INTO frames (id, sequence_id, frame_index, width, height)
               VALUES (1, 1, 0, 2, 2), (2, 1, 1, 2, 2), (3, 2, 0, 2, 2), (4, 3, 0, 2, 2);
             INSERT INTO main.classifications (frame_id, task_name, selected_classes) VALUES
               (1, 'grade', '[\"mild\"]'), (2, 'grade', '[\"severe\"]'),
               (2, 'findings', '[\"b\", \"a\"]'), (3, 'grade', '[\"mild\"]');
             INSERT INTO main.regressions (frame_id, task_name, value) VALUES
               (1, 'age', 40), (2, 'age', 50), (3, 'score', 0.25);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_sequence_gathers_the_classes_and_the_mean_value_of_its_frames() {
        let answers = gallery_answers(&fixture()).unwrap();
        assert_eq!(answers.len(), 2, "a sequence without an answer is left out");

        let first = &answers[0];
        assert_eq!(first.sequence_id, 1);
        assert_eq!(first.classes["grade"], ["mild", "severe"]);
        assert_eq!(first.classes["findings"], ["a", "b"]);
        assert_eq!(first.regressions["age"], 45.0);

        let second = &answers[1];
        assert_eq!(second.sequence_id, 2);
        assert_eq!(second.classes["grade"], ["mild"]);
        assert_eq!(second.regressions["score"], 0.25);
        assert!(!second.regressions.contains_key("age"));
    }

    #[test]
    fn answers_are_those_of_the_logged_in_user() {
        let conn = fixture();
        conn.execute_batch(
            "INSERT INTO users (id, name) VALUES (2, 'second');
             INSERT INTO main.regressions (frame_id, user_id, task_name, value)
               VALUES (4, 2, 'age', 70);",
        )
        .unwrap();
        assert_eq!(gallery_answers(&conn).unwrap().len(), 2);

        queries::set_session_user(&conn, Some(2)).unwrap();
        let answers = gallery_answers(&conn).unwrap();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].sequence_id, 3);
        assert_eq!(answers[0].regressions["age"], 70.0);
    }
}
