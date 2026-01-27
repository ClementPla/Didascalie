use rusqlite::params;
use tauri::State;
use serde::{Deserialize, Serialize};
use crate::storage::DbState;
use crate::utils::AppError;
use crate::utils::error::Result;


#[derive(Serialize, Deserialize, Debug)]
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

        // Build task name -> index map
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

        // Query classifications for this frame
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
        if selected_classes.is_empty() {
            // Delete if no classes selected
            conn.execute(
                "DELETE FROM classifications WHERE frame_id = ?1 AND task_name = ?2",
                params![frame_id, task_name],
            ).map_err(AppError::Database)?;
        } else {
            conn.execute(
                "INSERT OR REPLACE INTO classifications 
                 (frame_id, task_name, selected_classes, is_multilabel, modified_at)
                 VALUES (?1, ?2, ?3, ?4, datetime('now'))",
                params![
                    frame_id,
                    task_name,
                    serde_json::to_string(&selected_classes).unwrap_or_default(),
                    is_multilabel,
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
        let tx = conn.unchecked_transaction()?;

        for c in classifications {
            tx.execute(
                "INSERT OR REPLACE INTO classifications 
                 (frame_id, task_name, selected_classes, is_multilabel, modified_at)
                 VALUES (?1, ?2, ?3, ?4, datetime('now'))",
                params![
                    c.frame_id,
                    c.task_name,
                    serde_json::to_string(&c.selected_classes)?,
                    c.is_multilabel,
                ],
            )?;
        }

        tx.commit()?;
        Ok(())
    })
}