use std::path::Path;
use tauri::State;

use crate::utils::error::Result;
use crate::storage::{DbState, queries};
use crate::types::project::ProjectConfig;
use crate::commands::frame::{FrameImageCache, ThumbnailCache};
use crate::commands::ml::predict::MlState;

/// Forget everything derived from the project being left.
///
/// Frame and label ids restart from 1 in every project, so anything cached
/// under them is silently wrong for the next one: the gallery showed the
/// previous project's thumbnails, for instance. Every command that changes the
/// open database goes through here.
fn forget_project(thumbnails: &ThumbnailCache, tiles: &FrameImageCache, ml: &MlState) {
    thumbnails.clear();
    tiles.clear();
    // A head only means anything against the labels it was fitted to, and the
    // encoder features belong to one frame of one project.
    *ml.model.lock() = None;
    *ml.features.lock() = None;
}

#[tauri::command]
pub fn create_project(
    db: State<DbState>,
    ml: State<MlState>,
    thumbnails: State<ThumbnailCache>,
    tiles: State<FrameImageCache>,
    path: String,
    config: ProjectConfig,
) -> Result<()> {
    log::info!("[project] creating at {}", path);
    forget_project(&thumbnails, &tiles, &ml);
    
    let conn = queries::create_database(Path::new(&path))?;
    queries::insert_project(&conn, &config)?;
    
    // Sync labels table from config
    queries::sync_labels_from_config(&conn, &config)?;

    // A new project has exactly one account, its creator's, so this logs in.
    queries::install_user_scope(&conn)?;
    crate::commands::users::auto_login(&conn)?;

    db.set(conn);
    Ok(())
}

#[tauri::command]
pub fn open_project(
    db: State<DbState>,
    ml: State<MlState>,
    thumbnails: State<ThumbnailCache>,
    tiles: State<FrameImageCache>,
    path: String,
) -> Result<ProjectConfig> {
    if db.is_open() {
        log::info!("[project] closing the open project first");
        db.close();
    }
    forget_project(&thumbnails, &tiles, &ml);

    let conn = queries::open_database(Path::new(&path))?;
    let config = queries::get_project_config(&conn)?;

    // Ensure labels table is in sync with config
    queries::sync_labels_from_config(&conn, &config)?;

    // From here on the connection shows one user's annotations. With a single
    // passwordless account that user is known already; otherwise the frontend
    // asks who is there before anything else is loaded.
    queries::install_user_scope(&conn)?;
    crate::commands::users::auto_login(&conn)?;

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
    ml: State<MlState>,
    thumbnails: State<ThumbnailCache>,
    tiles: State<FrameImageCache>,
) -> Result<()> {
    db.close();
    forget_project(&thumbnails, &tiles, &ml);
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