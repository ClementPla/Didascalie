use std::path::Path;
use tauri::State;

use crate::utils::error::Result;
use crate::storage::{DbState, queries};
use crate::types::project::ProjectConfig;

#[tauri::command]
pub fn create_project(
    db: State<DbState>,
    path: String,
    config: ProjectConfig,
) -> Result<()> {
    dbg!("Creating project at path: {}", &path);
    
    let conn = queries::create_database(Path::new(&path))?;
    queries::insert_project(&conn, &config)?;
    
    // Sync labels table from config
    queries::sync_labels_from_config(&conn, &config)?;
    
    db.set(conn);
    Ok(())
}

#[tauri::command]
pub fn open_project(db: State<DbState>, path: String) -> Result<ProjectConfig> {
    if db.is_open() {
        dbg!("Closing existing project before opening a new one.");
        db.close();
    }
    
    let conn = queries::open_database(Path::new(&path))?;
    let config = queries::get_project_config(&conn)?;
    
    // Ensure labels table is in sync with config
    queries::sync_labels_from_config(&conn, &config)?;
    
    db.set(conn);
    Ok(config)
}

#[tauri::command]
pub fn close_project(db: State<DbState>) -> Result<()> {
    db.close();
    Ok(())
}

#[tauri::command]
pub fn get_frames_count(db: State<DbState>) -> Result<i64> {
    db.with_conn(|conn| queries::get_frames_count(conn))
}

#[tauri::command]
pub fn get_sequences_count(db: State<DbState>) -> Result<i64> {
    db.with_conn(|conn| queries::get_sequences_count(conn))
}