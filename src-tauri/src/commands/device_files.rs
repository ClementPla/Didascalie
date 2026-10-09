//! Projects coming from, and going back to, the device's shared storage.
//!
//! On Android a file the user picks, or opens Didascalie with, is not a path
//! but a `content://` URI, readable only as a stream. SQLite needs a real,
//! writable file, so a project is **imported**: copied into the application's
//! own storage, where it is opened and edited like any other. Getting the work
//! back out is the reverse copy, to wherever the user chooses.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, State};
use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

use crate::storage::DbState;
use crate::utils::error::Result;
use crate::utils::AppError;

/// Every SQLite database starts with these bytes.
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

fn data_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_data_dir().map_err(|e| AppError::Other(e.to_string()))
}

fn parse_location(location: &str) -> Result<FilePath> {
    location
        .parse::<FilePath>()
        .map_err(|_| AppError::Other(format!("Cannot read the location {location}")))
}

/// Move a received file into `projects/`, refusing anything that is not a
/// project. Returns its new path.
fn adopt(app: &AppHandle, received: &Path) -> Result<String> {
    let mut header = [0u8; 16];
    let is_sqlite = fs::File::open(received)
        .and_then(|mut f| io::Read::read_exact(&mut f, &mut header))
        .is_ok()
        && header == SQLITE_MAGIC;
    if !is_sqlite {
        let _ = fs::remove_file(received);
        return Err(AppError::Other("This file is not a Didascalie project.".into()));
    }

    let projects = data_dir(app)?.join("projects");
    fs::create_dir_all(&projects)?;
    // The URI gives no dependable file name, and two projects sent a week
    // apart can share one anyway.
    let path = projects.join(format!("{}.dida", uuid::Uuid::new_v4()));
    fs::rename(received, &path)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Copy the project at `location` (a path or a `content://` URI) into the
/// application's storage and return the path of the copy.
#[tauri::command]
pub fn import_project_file(app: AppHandle, location: String) -> Result<String> {
    let mut source = app
        .fs()
        .open(parse_location(&location)?, OpenOptions::new().read(true).to_owned())
        .map_err(|e| AppError::Other(format!("Could not read the file: {e}")))?;

    let dir = data_dir(&app)?;
    fs::create_dir_all(&dir)?;
    let partial = dir.join("import.part");
    io::copy(&mut source, &mut fs::File::create(&partial)?)?;
    adopt(&app, &partial)
}

/// A project the application was opened with ("Open with Didascalie"), if one
/// is waiting. The activity leaves it in `inbox/`; see `MainActivity.kt`.
#[tauri::command]
pub fn take_incoming_project(app: AppHandle) -> Result<Option<String>> {
    let incoming = data_dir(&app)?.join("inbox").join("incoming.dida");
    if !incoming.exists() {
        return Ok(None);
    }
    adopt(&app, &incoming).map(Some)
}

/// Write a copy of the open project, annotations included, to `location`.
#[tauri::command]
pub fn export_project_file(app: AppHandle, db: State<DbState>, location: String) -> Result<()> {
    // A snapshot rather than the live file, whose latest changes may still be
    // in the write-ahead log.
    let snapshot = data_dir(&app)?.join("export.part");
    let _ = fs::remove_file(&snapshot);
    db.with_conn(|conn| {
        conn.execute("VACUUM INTO ?1", [snapshot.to_string_lossy().as_ref()])?;
        Ok(())
    })?;

    let written = (|| -> Result<()> {
        let mut target = app
            .fs()
            .open(
                parse_location(&location)?,
                OpenOptions::new().write(true).create(true).truncate(true).to_owned(),
            )
            .map_err(|e| AppError::Other(format!("Could not write there: {e}")))?;
        io::copy(&mut fs::File::open(&snapshot)?, &mut target)?;
        Ok(())
    })();
    let _ = fs::remove_file(&snapshot);
    written
}
