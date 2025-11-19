pub use crate::dl::model_manager;
pub use model_manager::{ensure_model_cached, ModelConfig};
use ort::{
    execution_providers::{
        CUDAExecutionProvider, CoreMLExecutionProvider, DirectMLExecutionProvider,
        ExecutionProvider, TensorRTExecutionProvider,
    },
    session::{builder::GraphOptimizationLevel, Session},
};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct ModelSessions {
    encoder: Mutex<Option<Arc<Mutex<Session>>>>,
    decoder: Mutex<Option<Arc<Mutex<Session>>>>,
}

impl ModelSessions {
    pub fn new() -> Self {
        Self {
            encoder: Mutex::new(None),
            decoder: Mutex::new(None),
        }
    }
}

fn create_session(path: PathBuf, intra_threads: usize) -> Result<Session, ort::Error> {
    println!(
        "CUDA execution provider is available: {:?}",
        CUDAExecutionProvider::default().is_available()
    );

    println!("Building session with {} intra threads...", intra_threads);

    Session::builder()?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(intra_threads)?
        .with_execution_providers([
            CUDAExecutionProvider::default().build(),
            TensorRTExecutionProvider::default().build(),
            DirectMLExecutionProvider::default().build(),
            CoreMLExecutionProvider::default().build(),
        ])?
        .commit_from_file(path)
}

pub async fn get_encoder_async(
    app: &tauri::AppHandle,
    sessions: &ModelSessions,
) -> Result<Arc<Mutex<Session>>, String> {
    let mut encoder_opt = sessions.encoder.lock().await;

    if encoder_opt.is_none() {
        println!("Encoder not initialized, ensuring model is cached...");

        let config = ModelConfig::encoder();
        let model_path = ensure_model_cached(app, &config).await?;

        println!("Creating encoder session from: {:?}", model_path);
        let session = create_session(model_path, 6)
            .map_err(|e| format!("Failed to create encoder session: {}", e))?;

        *encoder_opt = Some(Arc::new(Mutex::new(session)));
        println!("Encoder session created successfully");
    }

    Ok(Arc::clone(encoder_opt.as_ref().unwrap()))
}

pub async fn get_decoder_async(
    app: &tauri::AppHandle,
    sessions: &ModelSessions,
) -> Result<Arc<Mutex<Session>>, String> {
    let mut decoder_opt = sessions.decoder.lock().await;

    if decoder_opt.is_none() {
        println!("Decoder not initialized, ensuring model is cached...");

        let config = ModelConfig::decoder();
        let model_path = ensure_model_cached(app, &config).await?;

        println!("Creating decoder session from: {:?}", model_path);
        let session = create_session(model_path, 4)
            .map_err(|e| format!("Failed to create decoder session: {}", e))?;

        *decoder_opt = Some(Arc::new(Mutex::new(session)));
        println!("Decoder session created successfully");
    }

    Ok(Arc::clone(decoder_opt.as_ref().unwrap()))
}
