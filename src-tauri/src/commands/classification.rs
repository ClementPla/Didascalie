use rusqlite::params;
use tauri::State;
use serde::{Deserialize, Serialize};
use crate::storage::{queries, DbState};
use crate::utils::AppError;
use crate::utils::error::Result;

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BatchClassificationPayload {
    pub frame_id: i64,
    pub task_name: String,
    pub selected_classes: Vec<String>,
    pub is_multilabel: bool,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClassificationData {
    pub task_name: String,
    pub task_index: i32,
    pub selected_classes: Vec<String>,
    pub is_multilabel: bool,
}

#[tauri::command]
pub fn load_classification(
    db: State<DbState>,
    frame_id: i64,
) -> Result<Vec<ClassificationData>> {
    db.with_conn(|conn| {
        // Load task order from project config to determine task_index
        let config_json: String = conn.query_row(
            "SELECT config FROM project WHERE id = 1",
            [],
            |row| row.get(0),
        ).map_err(AppError::Database)?;

        let config: serde_json::Value = serde_json::from_str(&config_json)
            .map_err(|e| AppError::Generic(format!("Failed to parse config: {}", e)))?;

        let mut task_index_map: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
        
        // Multiclass tasks
        if let Some(tasks) = config.get("classification_tasks").and_then(|v| v.as_array()) {
            for (i, task) in tasks.iter().enumerate() {
                if let Some(name) = task.get("name").and_then(|v| v.as_str()) {
                    task_index_map.insert(name.to_string(), i as i32);
                }
            }
        }

        // Multilabel task (use -1 or a special index)
        if let Some(multilabel) = config.get("multilabel_task") {
            if let Some(name) = multilabel.get("name").and_then(|v| v.as_str()) {
                task_index_map.insert(name.to_string(), -1);
            }
        }

        let mut stmt = conn.prepare(
            "SELECT task_name, selected_classes, is_multilabel
             FROM classifications
             WHERE frame_id = ?1"
        ).map_err(AppError::Database)?;

        let results = stmt.query_map(params![frame_id], |row| {
            let task_name: String = row.get(0)?;
            let selected_classes_json: String = row.get(1)?;
            let is_multilabel: bool = row.get(2)?;
            Ok((task_name, selected_classes_json, is_multilabel))
        }).map_err(AppError::Database)?;

        let mut classifications = Vec::new();
        for result in results {
            let (task_name, selected_classes_json, is_multilabel) = result.map_err(AppError::Database)?;
            
            let selected_classes: Vec<String> = serde_json::from_str(&selected_classes_json)
                .unwrap_or_default();

            let task_index = task_index_map.get(&task_name).copied().unwrap_or(-1);

            classifications.push(ClassificationData {
                task_name,
                task_index,
                selected_classes,
                is_multilabel,
            });
        }

        Ok(classifications)
    })
}

#[tauri::command]
pub fn save_classification(
    db: State<DbState>,
    frame_id: i64,
    task_name: String,
    selected_classes: Vec<String>,
    is_multilabel: bool,
) -> Result<()> {
    db.with_conn(|conn| {
        let user = queries::current_user_id(conn)?;
        if selected_classes.is_empty() {
            conn.execute(
                "DELETE FROM main.classifications
                 WHERE frame_id = ?1 AND task_name = ?2 AND user_id = ?3",
                params![frame_id, task_name, user],
            ).map_err(AppError::Database)?;
        } else {
            conn.execute(
                "INSERT OR REPLACE INTO main.classifications
                 (frame_id, user_id, task_name, selected_classes, is_multilabel, modified_at)
                 VALUES (?1, ?5, ?2, ?3, ?4, datetime('now'))",
                params![
                    frame_id,
                    task_name,
                    serde_json::to_string(&selected_classes).unwrap_or_default(),
                    is_multilabel,
                    user,
                ],
            ).map_err(AppError::Database)?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn save_batch_classifications(
    db: State<DbState>,
    classifications: Vec<BatchClassificationPayload>,
) -> Result<()> {
    db.with_conn(|conn| {
        let user = queries::current_user_id(conn)?;
        let tx = conn.unchecked_transaction()?;

        for c in classifications {
            tx.execute(
                "INSERT OR REPLACE INTO main.classifications
                 (frame_id, user_id, task_name, selected_classes, is_multilabel, modified_at)
                 VALUES (?1, ?5, ?2, ?3, ?4, datetime('now'))",
                params![
                    c.frame_id,
                    c.task_name,
                    serde_json::to_string(&c.selected_classes)?,
                    c.is_multilabel,
                    user,
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    })
}

// ── Whole sequences ────────────────────────────────────────────────────────

/// How the frames of a sequence are classified, by the current user.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SequenceClassification {
    /// Frames in the sequence, classified or not.
    pub frame_count: i64,
    /// One entry per distinct answer to a task. A task every frame answers the
    /// same way has a single entry covering `frame_count` frames.
    pub answers: Vec<SequenceClassificationAnswer>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SequenceClassificationAnswer {
    pub task_name: String,
    pub is_multilabel: bool,
    pub selected_classes: Vec<String>,
    /// Frames of the sequence giving this answer.
    pub frame_count: i64,
}

/// Summarise the classification of a sequence without loading it frame by
/// frame: a video is a sequence of thousands.
#[tauri::command]
pub fn get_sequence_classification(
    db: State<DbState>,
    sequence_id: i64,
) -> Result<SequenceClassification> {
    db.with_conn(|conn| sequence_classification(conn, sequence_id))
}

fn sequence_classification(
    conn: &rusqlite::Connection,
    sequence_id: i64,
) -> Result<SequenceClassification> {
    let frame_count = conn.query_row(
        "SELECT COUNT(*) FROM frames WHERE sequence_id = ?1",
        params![sequence_id],
        |row| row.get(0),
    )?;
    let mut stmt = conn.prepare(
        "SELECT c.task_name, c.is_multilabel, c.selected_classes, COUNT(*)
         FROM classifications c
         JOIN frames f ON f.id = c.frame_id
         WHERE f.sequence_id = ?1
         GROUP BY c.task_name, c.is_multilabel, c.selected_classes
         ORDER BY c.task_name",
    )?;
    let answers = stmt
        .query_map(params![sequence_id], |row| {
            let classes: String = row.get(2)?;
            Ok(SequenceClassificationAnswer {
                task_name: row.get(0)?,
                is_multilabel: row.get(1)?,
                selected_classes: serde_json::from_str(&classes).unwrap_or_default(),
                frame_count: row.get(3)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(SequenceClassification { frame_count, answers })
}

/// Give every frame of a sequence the same answer to a task, replacing what
/// each had. No class selected removes the answer. Returns the number of
/// frames in the sequence.
#[tauri::command]
pub fn save_sequence_classification(
    db: State<DbState>,
    sequence_id: i64,
    task_name: String,
    selected_classes: Vec<String>,
    is_multilabel: bool,
) -> Result<usize> {
    db.with_conn(|conn| {
        classify_sequence(conn, sequence_id, &task_name, &selected_classes, is_multilabel)
    })
}

fn classify_sequence(
    conn: &rusqlite::Connection,
    sequence_id: i64,
    task_name: &str,
    selected_classes: &[String],
    is_multilabel: bool,
) -> Result<usize> {
    let user = queries::current_user_id(conn)?;
    if selected_classes.is_empty() {
        conn.execute(
            "DELETE FROM main.classifications
             WHERE task_name = ?2 AND user_id = ?3
               AND frame_id IN (SELECT id FROM frames WHERE sequence_id = ?1)",
            params![sequence_id, task_name, user],
        )?;
        let frames: i64 = conn.query_row(
            "SELECT COUNT(*) FROM frames WHERE sequence_id = ?1",
            params![sequence_id],
            |row| row.get(0),
        )?;
        return Ok(frames as usize);
    }
    // One statement, so the sequence is never left half classified.
    let frames = conn.execute(
        "INSERT OR REPLACE INTO main.classifications
         (frame_id, user_id, task_name, selected_classes, is_multilabel, modified_at)
         SELECT id, ?5, ?2, ?3, ?4, datetime('now') FROM frames WHERE sequence_id = ?1",
        params![
            sequence_id,
            task_name,
            serde_json::to_string(selected_classes)?,
            is_multilabel,
            user,
        ],
    )?;
    Ok(frames)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// Two sequences: frames 1-3 in the first, frame 4 in the second.
    fn fixture() -> Connection {
        let conn = queries::create_database(std::path::Path::new(":memory:")).unwrap();
        queries::install_user_scope(&conn).unwrap();
        crate::commands::users::auto_login(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sequences (id, name) VALUES (1, 'a'), (2, 'b');
             INSERT INTO frames (id, sequence_id, frame_index, width, height)
               VALUES (1, 1, 0, 2, 2), (2, 1, 1, 2, 2), (3, 1, 2, 2, 2), (4, 2, 0, 2, 2);",
        )
        .unwrap();
        conn
    }

    fn classes(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn a_sequence_is_classified_as_one_and_only_that_sequence() {
        let conn = fixture();
        assert_eq!(classify_sequence(&conn, 1, "quality", &classes(&["good"]), false).unwrap(), 3);

        let summary = sequence_classification(&conn, 1).unwrap();
        assert_eq!(summary.frame_count, 3);
        assert_eq!(summary.answers.len(), 1);
        assert_eq!(summary.answers[0].selected_classes, ["good"]);
        assert_eq!(summary.answers[0].frame_count, 3);
        assert!(sequence_classification(&conn, 2).unwrap().answers.is_empty());
    }

    #[test]
    fn frames_that_differ_are_reported_then_overwritten() {
        let conn = fixture();
        classify_sequence(&conn, 1, "quality", &classes(&["good"]), false).unwrap();
        conn.execute(
            "UPDATE main.classifications SET selected_classes = '[\"bad\"]' WHERE frame_id = 2",
            [],
        )
        .unwrap();
        let mixed = sequence_classification(&conn, 1).unwrap();
        assert_eq!(mixed.answers.len(), 2);

        classify_sequence(&conn, 1, "quality", &classes(&["bad"]), false).unwrap();
        let uniform = sequence_classification(&conn, 1).unwrap();
        assert_eq!(uniform.answers.len(), 1);
        assert_eq!(uniform.answers[0].frame_count, 3);
    }

    #[test]
    fn tasks_are_independent_and_an_empty_answer_removes_one() {
        let conn = fixture();
        classify_sequence(&conn, 1, "quality", &classes(&["good"]), false).unwrap();
        classify_sequence(&conn, 1, "findings", &classes(&["a", "b"]), true).unwrap();
        assert_eq!(sequence_classification(&conn, 1).unwrap().answers.len(), 2);

        assert_eq!(classify_sequence(&conn, 1, "findings", &[], true).unwrap(), 3);
        let left = sequence_classification(&conn, 1).unwrap();
        assert_eq!(left.answers.len(), 1);
        assert_eq!(left.answers[0].task_name, "quality");
        assert!(!left.answers[0].is_multilabel);
    }
}
