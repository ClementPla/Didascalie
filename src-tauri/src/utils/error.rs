use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {

    #[error("Generic error: {0}")]
    Generic(String),
     
    // Storage errors
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    
    #[error("No project open")]
    NoProjectOpen,
    
    #[error("Project already open")]
    #[allow(dead_code)] // reserved for future use
    ProjectAlreadyOpen,
    
    // IO errors
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),
    
    // Serialization
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    
    // Communication
    #[error("ZMQ error: {0}")]
    Zmq(#[from] zmq::Error),
    
    #[error("Event error: {0}")]
    #[allow(dead_code)] // reserved for future use
    Event(String),

    #[error("Timeout")]
    #[allow(dead_code)] // reserved for future use
    Timeout,
    
    // Tauri
    #[error("Tauri error: {0}")]
    Tauri(String),
    
    // Generic
    #[error("{0}")]
    #[allow(dead_code)] // reserved for future use
    Other(String),
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        AppError::Tauri(error.to_string())
    }
}

impl From<crate::connection::types::ComError> for AppError {
    fn from(e: crate::connection::types::ComError) -> Self {
        AppError::Generic(e.to_string())
    }
}

// For Tauri commands - converts to string
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;