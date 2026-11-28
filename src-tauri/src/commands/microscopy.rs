//! Commands for the microscopy import (see `crate::microscopy`): describe
//! files, then import the series picked from them.

use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use ts_rs::TS;

use crate::commands::io::AddImagesResult;
use crate::storage::DbState;
use crate::microscopy::{self, import, MicroscopyFile, MicroscopyImport};
use crate::utils::error::{AppError, Result};

/// One file described by [`inspect_microscopy`]: its series, or why it cannot
/// be read.
#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct MicroscopyInspection {
    pub path: String,
    #[ts(optional = nullable)]
    pub file: Option<MicroscopyFile>,
    #[ts(optional = nullable)]
    pub error: Option<String>,
}

/// Describe microscopy files, one at a time, away from the main thread.
#[tauri::command]
pub async fn inspect_microscopy(paths: Vec<String>) -> Result<Vec<MicroscopyInspection>> {
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| match microscopy::inspect(Path::new(&path)) {
                Ok(file) => MicroscopyInspection { path, file: Some(file), error: None },
                Err(e) => MicroscopyInspection { path, file: None, error: Some(e.to_string()) },
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::Generic(e.to_string()))
}

/// The microscopy files a folder scan with `options` would take, for the
/// import dialog to describe before the scan runs.
#[tauri::command]
pub async fn find_microscopy_files(options: crate::commands::io::ScanOptions) -> Result<Vec<String>> {
    tauri::async_runtime::spawn_blocking(move || crate::commands::io::find_microscopy(&options))
        .await
        .map_err(|e| AppError::Generic(e.to_string()))?
}

/// Convert and add microscopy files to the open project, one sequence per
/// series. A file the project already holds is skipped; one that fails is
/// reported in `errors` and leaves nothing behind.
#[tauri::command]
pub async fn import_microscopy(app: AppHandle, files: Vec<MicroscopyImport>) -> Result<AddImagesResult> {
    tauri::async_runtime::spawn_blocking(move || import_files(&app.state::<DbState>(), files))
        .await
        .map_err(|e| AppError::Generic(e.to_string()))?
}

fn import_files(db: &DbState, files: Vec<MicroscopyImport>) -> Result<AddImagesResult> {
    // Who may import, and where the image folder is, before the slow part.
    let folder = db.with_conn(|conn| {
        crate::commands::users::require_admin(conn)?;
        let config = crate::storage::queries::get_project_config(conn)?;
        Ok(crate::frames::resolve_image_folder(&config))
    })?;

    let mut result = AddImagesResult::default();
    let mut prepared = Vec::new();
    for file in files {
        let path = Path::new(&file.path);
        let source = source_path(path, folder.as_deref());
        let known = db.with_conn(|conn| import::already_imported(conn, &source))?;
        if known {
            result.frames_skipped += 1;
            continue;
        }
        log::info!("[microscopy] converting {}", file.path);
        if file.series.as_ref().is_some_and(|s| s.is_empty()) {
            continue;
        }
        match import::prepare(path, &source, file.series) {
            Ok(p) => prepared.push(p),
            Err(e) => result.errors.push(format!("{}: {}", file.path, e)),
        }
    }

    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        for file in &prepared {
            tx.execute_batch("SAVEPOINT microscopy_file")?;
            match import::insert(&tx, file) {
                Ok((sequences, frames)) => {
                    tx.execute_batch("RELEASE microscopy_file")?;
                    result.sequences_created += sequences;
                    result.frames_imported += frames;
                    result.frames_embedded += frames;
                }
                Err(e) => {
                    tx.execute_batch("ROLLBACK TO microscopy_file; RELEASE microscopy_file")?;
                    result.errors.push(format!("{}: {}", file.source_path, e));
                }
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(result)
}

/// How the project names a file: relative to its image folder when inside it,
/// else absolute. Separators as a folder scan writes them, so both routes
/// recognise a file already imported.
fn source_path(path: &Path, folder: Option<&Path>) -> String {
    let absolute = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    folder
        .and_then(|f| std::fs::canonicalize(f).ok())
        .and_then(|f| absolute.strip_prefix(&f).ok().map(|r| r.to_string_lossy().to_string()))
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_inside_the_image_folder_are_relative() {
        let root = std::env::temp_dir().join("didascalie_microscopy_source_path");
        std::fs::create_dir_all(root.join("run")).unwrap();
        let file = root.join("run").join("plate.czi");
        std::fs::write(&file, b"x").unwrap();
        assert_eq!(source_path(&file, Some(&root)), Path::new("run").join("plate.czi").to_string_lossy());
        let elsewhere = std::env::temp_dir().join("didascalie_microscopy_elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        assert_eq!(source_path(&file, Some(&elsewhere)), file.to_string_lossy());
        assert_eq!(source_path(&file, None), file.to_string_lossy());
    }
}
