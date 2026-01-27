use serde::{Deserialize, Serialize};
use crate::types::project::ProjectConfig;

/// Commands received via ZMQ
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type", content = "data")]
pub enum ZmqCommand {
    CreateProject(ProjectConfig),
    LoadImage(LoadImageRequest),
    GetImages,
    NextImage,
    PreviousImage,
    SaveAnnotation(SaveAnnotationRequest),
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LoadImageRequest {
    pub image_path: String,
    pub mask_data: Option<Vec<String>>,  // Base64 encoded masks
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SaveAnnotationRequest {
    pub image_path: String,
    pub label_name: String,
    pub mask_base64: String,
}

/// Generic response wrapper
#[derive(Serialize, Deserialize, Debug)]
pub struct ZmqResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T> ZmqResponse<T> {
    pub fn ok(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }
    
    pub fn err(message: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(message.into()),
        }
    }
}


#[derive(Serialize, Deserialize, Debug)]
pub struct BatchClassificationPayload {
    pub frame_id: i64,
    pub task_name: String,
    pub selected_classes: Vec<String>,
    pub is_multilabel: bool,
}