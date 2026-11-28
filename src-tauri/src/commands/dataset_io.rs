//! Commands of the pluggable import/export system.

use std::path::Path;

use tauri::{AppHandle, Emitter, State};

use crate::commands::formats::storage::{export_source, write_dataset};
use crate::commands::formats::{self, FormatInfo, OptionValues};
use crate::storage::{queries, DbState};
use crate::types::dataset::FrameSource;
use crate::types::export::{ExportProgress, ExportResult, ImportResult};
use crate::utils::error::Result;
use crate::utils::AppError;

#[tauri::command]
pub fn list_dataset_formats() -> Vec<FormatInfo> {
    formats::format_infos()
}

#[tauri::command]
pub async fn export_dataset(
    app: AppHandle,
    db: State<'_, DbState>,
    format_id: String,
    output_folder: String,
    only_reviewed: bool,
    options: OptionValues,
) -> Result<ExportResult> {
    let exporter = formats::find_exporter(&format_id)
        .ok_or_else(|| AppError::Generic(format!("Unknown export format: {format_id}")))?;

    let name = db
        .with_conn(|conn| queries::get_project_config(conn).map(|c| c.name))
        .unwrap_or_else(|_| "project".to_string());
    // Frames are read one at a time while the files are written, each under
    // the DB lock only while it loads.
    let (info, mut frames) =
        export_source(&db, &name, only_reviewed, exporter.wants_images(&options))?;

    let mut errors: Vec<String> = Vec::new();
    let mut progress = progress_emitter(&app, "export-progress");
    let total_exported = match exporter.export(&info, &mut frames, Path::new(&output_folder), &options, &mut progress) {
        Ok(()) => frames.len() as u32,
        Err(e) => {
            errors.push(e.to_string());
            0
        }
    };

    Ok(ExportResult { total_exported, errors })
}

/// A format progress callback forwarding to `event` as [`ExportProgress`].
fn progress_emitter<'a>(app: &'a AppHandle, event: &'a str) -> impl FnMut(u32, u32, &str) + 'a {
    move |done, total, label| {
        let _ = app.emit(event, ExportProgress { current: done, total, current_file: label.to_string() });
    }
}

/// Import annotations from `path` (a file or folder) into the open project,
/// matching frames by filename. Missing labels are created.
#[tauri::command]
pub async fn import_dataset(
    app: AppHandle,
    db: State<'_, DbState>,
    format_id: String,
    path: String,
    options: OptionValues,
) -> Result<ImportResult> {
    let importer = formats::find_importer(&format_id)
        .ok_or_else(|| AppError::Generic(format!("Unknown import format: {format_id}")))?;

    // Not `import-progress`: that event carries `ImportProgress`, the image
    // import's payload, which the frontend listens for.
    let mut progress = progress_emitter(&app, "dataset-import-progress");
    let dataset = importer.import(Path::new(&path), &options, &mut progress)?;

    // One transaction: a failure midway leaves nothing.
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let result = write_dataset(&tx, &dataset)?;
        tx.commit()?;
        Ok(result)
    })
}
