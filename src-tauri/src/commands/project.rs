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
    log::info!("[project] creating at {}", path);
    
    let conn = queries::create_database(Path::new(&path))?;
    queries::insert_project(&conn, &config)?;
    
    // Sync labels table from config
    queries::sync_labels_from_config(&conn, &config)?;
    
    db.set(conn);
    Ok(())
}

#[tauri::command]
pub fn open_project(
    db: State<DbState>,
    ml: State<crate::commands::ml::predict::MlState>,
    path: String,
) -> Result<ProjectConfig> {
    if db.is_open() {
        log::info!("[project] closing the open project first");
        db.close();
        *ml.model.lock() = None;
    }

    let conn = queries::open_database(Path::new(&path))?;
    let config = queries::get_project_config(&conn)?;

    // Ensure labels table is in sync with config
    queries::sync_labels_from_config(&conn, &config)?;

    db.set(conn);
    // Restore this project's trained head, if it has one, so predicting works
    // straight away rather than only after a visit to the model page. Failure is
    // silent by design — most projects have no model, and one this build cannot
    // read leaves the user exactly where they were: able to retrain.
    crate::commands::ml::commands::ml_load_saved_model(db, ml);
    Ok(config)
}

#[tauri::command]
pub fn close_project(
    db: State<DbState>,
    ml: State<crate::commands::ml::predict::MlState>,
) -> Result<()> {
    db.close();
    // A head only means anything against the labels it was fitted to, so it must
    // not outlive its project into the next one.
    *ml.model.lock() = None;
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