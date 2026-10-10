pub mod schema;
pub mod queries;
pub mod rle;

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Mutex;
use crate::utils::error::{AppError, Result};

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
    
    pub fn set(&self, conn: Connection) {
        *self.conn.lock().unwrap() = Some(conn);
    }
    
    pub fn image_root(&self) -> Option<PathBuf> {
        self.image_root.lock().unwrap().clone()
    }

    pub fn set_image_root(&self, root: Option<PathBuf>) {
        *self.image_root.lock().unwrap() = root;
    }

    pub fn close(&self) {
    self.set_image_root(None);
    let mut guard = self.conn.lock().unwrap();
    if let Some(conn) = guard.take() { // .take() removes the connection from the Option
        // Checkpoint the WAL into the main file. Errors are ignored: we are closing.
        let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", []);
        
        let _ = conn.close(); 
        println!("Database closed and checkpointed.");
    }
}
    
    pub fn is_open(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }
    
    pub fn with_conn<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T>,
    {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().ok_or(AppError::NoProjectOpen)?;
        f(conn)
    }

}

impl Default for DbState {
    fn default() -> Self {
        Self::new()
    }
}