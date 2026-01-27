use rusqlite::params;
use tauri::State;
use serde::{Deserialize, Serialize};

use crate::storage::DbState;
use crate::utils::error::Result;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TextDescriptionData {
    pub field_name: String,
    pub content: String,
}

#[tauri::command]
pub fn load_text_descriptions(db: State<DbState>, frame_id: i64) -> Result<Vec<TextDescriptionData>> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare(
            "SELECT label_name, content FROM text_descriptions WHERE frame_id = ?1"
        )?;
        
        let rows = stmt.query_map(params![frame_id], |row| {
            Ok(TextDescriptionData {
                field_name: row.get(0)?,
                content: row.get(1)?,
            })
        })?;
        
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

#[tauri::command]
pub fn save_text_description(
    db: State<DbState>,
    frame_id: i64,
    field_name: String,
    content: String,
) -> Result<()> {
    db.with_conn(|conn| {
        if content.is_empty() {
            // Delete if content is empty
            conn.execute(
                "DELETE FROM text_descriptions WHERE frame_id = ?1 AND label_name = ?2",
                params![frame_id, field_name],
            )?;
        } else {
            conn.execute(
                "INSERT OR REPLACE INTO text_descriptions (frame_id, label_name, content, modified_at)
                 VALUES (?1, ?2, ?3, datetime('now'))",
                params![frame_id, field_name, content],
            )?;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn delete_text_description(
    db: State<DbState>,
    frame_id: i64,
    field_name: String,
) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "DELETE FROM text_descriptions WHERE frame_id = ?1 AND label_name = ?2",
            params![frame_id, field_name],
        )?;
        Ok(())
    })
}