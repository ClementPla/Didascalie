pub mod schema;
pub mod queries;
pub mod rle;

use rusqlite::Connection;
use std::sync::Mutex;
use crate::utils::error::{AppError, Result};

/// Application database state - holds the open connection
pub struct DbState {
    pub(crate) conn: Mutex<Option<Connection>>,
}

impl DbState {
    pub fn new() -> Self {
        Self {
            conn: Mutex::new(None),
        }
    }
    
    pub fn set(&self, conn: Connection) {
        *self.conn.lock().unwrap() = Some(conn);
    }
    
    pub fn close(&self) {
    let mut guard = self.conn.lock().unwrap();
    if let Some(conn) = guard.take() { // .take() removes the connection from the Option
        // Attempt to checkpoint WAL into the main DB file
        // We ignore the error here because we are closing anyway
        let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE);", []);
        
        // Explicitly closing allows us to catch errors, 
        // though dropping (which happens here) is usually sufficient.
        let _ = conn.close(); 
        println!("Database closed and checkpointed.");
    }
}
    
    pub fn is_open(&self) -> bool {
        self.conn.lock().unwrap().is_some()
    }
    
    /// Execute a function with the connection
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