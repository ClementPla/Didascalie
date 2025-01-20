use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ComError {
    #[error("ZMQ error: {0}")]
    ZmqError(#[from] zmq::Error),
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Other error: {0}")]
    Other(String),
    #[error("Event error: {0}")]
    EventError(String),
    #[error("Timeout error")]
    Timeout,
}

impl From<tauri::Error> for ComError {

    fn from(error: tauri::Error) -> Self {

        ComError::Other(error.to_string())

    }
}
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MulticlassConfig{
    name: String,
    classes: Vec<String>,
    default: Option<String>,
}
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct MultilabelConfig{
    name: String,
    classes: Vec<String>,
    default: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectConfig {
    project_name: String,
    input_dir: String,
    output_dir: String,
    is_segmentation: bool,
    is_classification: bool,
    is_instance_segmentation: bool,
    has_text_description: bool,
    segmentation_classes: Option<Vec<String>>,
    classification_classes: Option<Vec<MulticlassConfig>>,
    classification_multilabel: Option<MultilabelConfig>,
    text_names: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ImageConfig {
    image_path: String,
    mask_data: Option<Vec<String>>,
    segmentation_classes: Option<Vec<String>>,
    classification_classes: Option<Vec<String>>,
    classification_multilabel: Option<Vec<String>>,
    texts: Option<Vec<String>>,
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize, Debug)]
pub enum Command {
    CreateProject(ProjectConfig),
    LoadImage(ImageConfig),
    GetImages,
    NextImage,
    PreviousImage,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct Response<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}