pub mod schema;
pub mod queries;
pub mod migrate;
pub mod rle;

use parking_lot::Mutex;
use rusqlite::Connection;
use std::path::PathBuf;
use crate::utils::error::{AppError, Result};

/// The open project's connection. One `parking_lot` mutex guards it: it does
/// not poison, so a panic inside [`DbState::with_conn`] fails that one call
/// instead of every later one. Connections are opened `SQLITE_OPEN_NO_MUTEX`;
/// this mutex is what serializes access to them.
pub struct DbState {
    pub(crate) conn: Mutex<Option<Connection>>,
    /// Where this computer finds the open project's image folder
    /// (`commands::project::resolve_image_folder`). None: the folder named in
    /// the project's config.
    image_root: Mutex<Option<PathBuf>>,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
            image_root: Mutex::new(None),
        }
    }

    /// Make `conn` the open project, closing the one it replaces, under one
    /// lock so no call sees the state in between.
    pub fn replace(&self, conn: Connection, image_root: Option<PathBuf>) {
        let mut guard = self.conn.lock();
        if let Some(old) = guard.replace(conn) {
            checkpoint_and_close(old);
        }
        *self.image_root.lock() = image_root;
    }

    #[cfg(test)]
    pub fn set(&self, conn: Connection) {
        self.replace(conn, None);
    }

    pub fn image_root(&self) -> Option<PathBuf> {
        self.image_root.lock().clone()
    }

    pub fn set_image_root(&self, root: Option<PathBuf>) {
        *self.image_root.lock() = root;
    }

    pub fn close(&self) {
        let mut guard = self.conn.lock();
        *self.image_root.lock() = None;
        if let Some(conn) = guard.take() {
            checkpoint_and_close(conn);
        }
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let guard = self.conn.lock();
        let conn = guard.as_ref().ok_or(AppError::NoProjectOpen)?;
        f(conn)
    }
}

/// Fold the WAL into the main file, then close. Errors are ignored: the
/// connection is going away either way.
fn checkpoint_and_close(conn: Connection) {
    let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", []);
    let _ = conn.close();
    log::info!("[project] database closed and checkpointed");
}

impl Default for DbState {
    fn default() -> Self {
        Self::new()
    }
}