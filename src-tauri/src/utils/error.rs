use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {

    #[error("Generic error: {0}")]
    Generic(String),
     
    #[error("Database error: {0}")]
    Database(#[from] rusqlite::Error),
    
    #[error("No project open")]
    NoProjectOpen,
    
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("Image error: {0}")]
    Image(#[from] image::ImageError),
    
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    
    #[cfg(not(target_os = "android"))]
    #[error("ZMQ error: {0}")]
    Zmq(#[from] zmq::Error),
    
    #[error("Tauri error: {0}")]
    Tauri(String),
    
    #[error("{0}")]
    Other(String),
}

/// A plain message, as the operator and ML helpers report errors. Shown as
/// is: `Other` displays nothing but the message.
impl From<String> for AppError {
    fn from(message: String) -> Self {
        AppError::Other(message)
    }
}

impl From<&str> for AppError {
    fn from(message: &str) -> Self {
        AppError::Other(message.to_string())
    }
}

impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        AppError::Tauri(error.to_string())
    }
}

#[cfg(not(target_os = "android"))]
impl From<crate::connection::types::ComError> for AppError {
    fn from(e: crate::connection::types::ComError) -> Self {
        AppError::Generic(e.to_string())
    }
}

// Tauri commands return the error as a string.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;