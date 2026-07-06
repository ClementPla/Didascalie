//! Frontend-facing commands for the pluggable import/export system. The UI
//! discovers formats + their options via `list_dataset_formats`, then runs one.

use std::path::Path;

use tauri::{AppHandle, Emitter, State};

use crate::commands::formats::storage::{build_dataset, write_dataset};
use crate::commands::formats::{self, FormatInfo, OptionValues};
use crate::storage::{queries, DbState};
use crate::types::export::{ExportProgress, ExportResult, ImportResult};
use crate::utils::error::Result;
use crate::utils::AppError;

/// Metadata for every format (id, name, direction, self-describing options).
#[tauri::command]
pub fn list_dataset_formats() -> Vec<FormatInfo> {
    formats::format_infos()
}

/// Export the open project with the chosen format into `output_folder`.
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

    // Build the IR while holding the DB lock, then release it before writing.
    let dataset = db.with_conn(|conn| {
        let name = queries::get_project_config(conn)
            .map(|c| c.name)
            .unwrap_or_else(|_| "project".to_string());
        build_dataset(conn, &name, only_reviewed)
    })?;

    let out = Path::new(&output_folder);
    let mut errors: Vec<String> = Vec::new();
    let emit = |done: u32, total: u32, label: &str| {
        let _ = app.emit(
            "export-progress",
            ExportProgress { current: done, total, current_file: label.to_string() },
        );
    };
    let mut progress = emit;

    if let Err(e) = exporter.export(&dataset, out, &options, &mut progress) {
        errors.push(e.to_string());
    }

    Ok(ExportResult { total_exported: dataset.frames.len() as u32, errors })
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

    let emit = |done: u32, total: u32, label: &str| {
        let _ = app.emit(
            "import-progress",
            ExportProgress { current: done, total, current_file: label.to_string() },
        );
    };
    let mut progress = emit;
    let dataset = importer.import(Path::new(&path), &options, &mut progress)?;

    // Write the whole import atomically so a mid-way failure leaves nothing.
    db.with_conn(|conn| {
        let tx = conn.unchecked_transaction()?;
        let result = write_dataset(&tx, &dataset)?;
        tx.commit()?;
        Ok(result)
    })
}
