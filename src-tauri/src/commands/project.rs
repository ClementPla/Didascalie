use ts_rs::TS;
use std::path::{Path, PathBuf};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::utils::error::{AppError, Result};
use crate::storage::{DbState, queries};
use crate::frames::{join_relative, resolve_image_folder};
use crate::types::project::ProjectConfig;
use crate::commands::frame::{FrameImageCache, ThumbnailCache};
use crate::pixels::cache::RawFrameCache;
use crate::commands::ml::predict::MlState;

/// Forget everything derived from the project being left: frame and label
/// ids restart from 1 in every project. Every command that changes the open
/// database goes through here.
fn forget_project(thumbnails: &ThumbnailCache, tiles: &FrameImageCache, raw: &RawFrameCache, ml: &MlState) {
    thumbnails.clear();
    tiles.clear();
    raw.clear();
    *ml.model.lock() = None;
    *ml.features.lock() = None;
}

/// The image folder of the open project, as this computer sees it.
#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ImageFolderStatus {
    /// None when the project has no image folder (everything is embedded).
    pub folder: Option<String>,
    /// Images are read from it, and it is not there.
    pub missing: bool,
}

/// A file the project reads from its image folder, to check that a folder is
/// the right one.
fn sample_image_path(conn: &rusqlite::Connection) -> Result<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT relative_path FROM videos
         UNION ALL
         SELECT relative_path FROM frames
          WHERE embedded_data IS NULL AND video_id IS NULL AND relative_path IS NOT NULL
         LIMIT 1",
    )?;
    let mut rows = stmt.query([])?;
    Ok(match rows.next()? {
        Some(row) => Some(row.get(0)?),
        None => None,
    })
}

fn image_folder_status(db: &DbState) -> Result<ImageFolderStatus> {
    let root = db.image_root();
    let reads_files = db.with_conn(|conn| Ok(sample_image_path(conn)?.is_some()))?;
    Ok(ImageFolderStatus {
        missing: reads_files && root.as_ref().is_some_and(|folder| !folder.is_dir()),
        folder: root.map(|folder| folder.to_string_lossy().into_owned()),
    })
}

#[tauri::command]
pub fn get_image_folder(db: State<DbState>) -> Result<ImageFolderStatus> {
    image_folder_status(&db)
}

/// Tell the project where its image folder is on this computer. The path is
/// added to those already known, not swapped for them.
#[tauri::command]
pub fn set_image_folder(
    db: State<DbState>,
    thumbnails: State<ThumbnailCache>,
    tiles: State<FrameImageCache>,
    raw: State<RawFrameCache>,
    path: String,
) -> Result<ImageFolderStatus> {
    let folder = PathBuf::from(&path);
    if !folder.is_dir() {
        return Err(AppError::Other(format!("Folder not found: {}", path)));
    }
    db.with_conn(|conn| {
        if let Some(sample) = sample_image_path(conn)? {
            if !join_relative(&folder, &sample).exists() {
                return Err(AppError::Other(format!(
                    "This is not the project's image folder: it has no {}",
                    sample
                )));
            }
        }
        let mut config = queries::get_project_config(conn)?;
        let known = config.input_folder.as_deref() == Some(path.as_str())
            || config.input_folder_alternates.contains(&path);
        if config.input_folder.is_none() {
            config.input_folder = Some(path.clone());
        } else if !known {
            config.input_folder_alternates.push(path.clone());
        }
        conn.execute(
            "UPDATE project SET config = ?1 WHERE id = 1",
            params![serde_json::to_string(&config)?],
        )?;
        Ok(())
    })?;
    log::info!("[project] image folder located at {}", path);
    db.set_image_root(Some(folder));
    thumbnails.clear();
    tiles.clear();
    raw.clear();
    image_folder_status(&db)
}

#[tauri::command]
pub fn create_project(
    db: State<DbState>,
    ml: State<MlState>,
    thumbnails: State<ThumbnailCache>,
    tiles: State<FrameImageCache>,
    raw: State<RawFrameCache>,
    path: String,
    config: ProjectConfig,
) -> Result<()> {
    log::info!("[project] creating at {}", path);
    // Opening an existing file would migrate it before the insert below
    // fails: refuse first, so it is left untouched.
    let target = Path::new(&path);
    if target.metadata().map(|m| m.len() > 0).unwrap_or(false) {
        return Err(AppError::Generic(format!(
            "A file already exists at {path}. Choose another name, or open it as a project."
        )));
    }

    let conn = queries::create_database(target)?;
    queries::insert_project(&conn, &config)?;

    queries::sync_labels_from_config(&conn, &config)?;

    // A new project has exactly one account, its creator's, so this logs in.
    queries::install_user_scope(&conn)?;
    crate::commands::users::auto_login(&conn)?;

    // Only now that the new project is up is the old one closed and its
    // caches dropped.
    db.replace(conn, resolve_image_folder(&config));
    forget_project(&thumbnails, &tiles, &raw, &ml);
    Ok(())
}

#[tauri::command]
pub fn open_project(
    db: State<DbState>,
    ml: State<MlState>,
    thumbnails: State<ThumbnailCache>,
    tiles: State<FrameImageCache>,
    raw: State<RawFrameCache>,
    path: String,
) -> Result<ProjectConfig> {
    let conn = queries::open_database(Path::new(&path))?;
    let config = queries::get_project_config(&conn)?;

    queries::sync_labels_from_config(&conn, &config)?;

    // From here on the connection shows one user's annotations.
    queries::install_user_scope(&conn)?;
    crate::commands::users::auto_login(&conn)?;

    // Swapped under one lock, closing whatever was open; then the caches,
    // keyed by ids that restart at 1 in every project, are dropped.
    db.replace(conn, resolve_image_folder(&config));
    forget_project(&thumbnails, &tiles, &raw, &ml);
    // Restore the project's trained head, if any.
    crate::commands::ml::commands::ml_load_saved_model(db, ml);
    Ok(config)
}

#[tauri::command]
pub fn close_project(
    db: State<DbState>,
    ml: State<MlState>,
    thumbnails: State<ThumbnailCache>,
    tiles: State<FrameImageCache>,
    raw: State<RawFrameCache>,
) -> Result<()> {
    db.close();
    forget_project(&thumbnails, &tiles, &raw, &ml);
    Ok(())
}

#[tauri::command]
pub fn get_frames_count(db: State<DbState>) -> Result<i64> {
    db.with_conn(queries::get_frames_count)
}

#[tauri::command]
pub fn get_sequences_count(db: State<DbState>) -> Result<i64> {
    db.with_conn(queries::get_sequences_count)
}
#[cfg(test)]
mod tests {
    use super::*;

    fn config(folder: &str, alternates: &[&str]) -> ProjectConfig {
        ProjectConfig {
            input_folder: Some(folder.into()),
            input_folder_alternates: alternates.iter().map(|a| a.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn the_folder_the_project_was_created_with_is_used_when_it_is_there() {
        let here = std::env::temp_dir();
        let config = config(here.to_str().unwrap(), &["/nowhere/else"]);
        assert_eq!(resolve_image_folder(&config), Some(here));
    }

    #[test]
    fn another_known_path_is_used_when_the_first_is_not_on_this_computer() {
        let here = std::env::temp_dir();
        let config = config(r"\\server\share\images", &["/nowhere", here.to_str().unwrap()]);
        assert_eq!(resolve_image_folder(&config), Some(here));
    }

    #[test]
    fn a_folder_found_nowhere_is_still_named() {
        let config = config("/nowhere/images", &["/nowhere/else"]);
        assert_eq!(resolve_image_folder(&config), Some(PathBuf::from("/nowhere/images")));
        assert_eq!(resolve_image_folder(&ProjectConfig::default()), None);
    }

    #[test]
    fn alternates_are_absent_from_a_config_that_has_none() {
        let json = serde_json::to_string(&config("/images", &[])).unwrap();
        assert!(!json.contains("input_folder_alternates"));
        let back: ProjectConfig = serde_json::from_str(&json).unwrap();
        assert!(back.input_folder_alternates.is_empty());
    }

    #[cfg(not(windows))]
    #[test]
    fn a_path_imported_on_windows_is_found_elsewhere() {
        assert_eq!(
            join_relative(Path::new("/images"), r"patient\eye\video.mkv"),
            PathBuf::from("/images/patient/eye/video.mkv"),
        );
    }
}

/// Which of these project files exist on this computer, in order: the launcher
/// greys out the recent projects it cannot reach (an unplugged drive, a share
/// not mounted) instead of forgetting them.
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|path| Path::new(path).is_file()).collect()
}
