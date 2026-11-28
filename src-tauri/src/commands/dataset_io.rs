//! Commands of the pluggable import/export system.

use std::path::Path;

use tauri::{AppHandle, Emitter, State};

use crate::commands::formats::storage::{build_dataset, write_dataset};
use crate::commands::formats::{self, FormatInfo, OptionValues};
use crate::storage::{queries, DbState};
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

    // Build the IR under the DB lock, then release it before writing.
    let dataset = db.with_conn(|conn| {
        let name = queries::get_project_config(conn)
            .map(|c| c.name)
            .unwrap_or_else(|_| "project".to_string());
        build_dataset(conn, &name, only_reviewed)
    })?;

    let mut errors: Vec<String> = Vec::new();
    let mut progress = progress_emitter(&app, "export-progress");
    let total_exported = match exporter.export(&dataset, Path::new(&output_folder), &options, &mut progress) {
        Ok(()) => dataset.frames.len() as u32,
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
