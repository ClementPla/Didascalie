use lazy_static::lazy_static;

use std::sync::OnceLock;
use ort::{
  execution_providers::{
    CUDAExecutionProvider, CoreMLExecutionProvider, DirectMLExecutionProvider, ExecutionProvider, TensorRTExecutionProvider
  },
  session::{ builder::GraphOptimizationLevel, Session },
};
use tauri::{ path::BaseDirectory, Manager };

lazy_static! {
  static ref MODEL_SESSION_ENCODER: OnceLock<Session> = OnceLock::new();
  static ref MODEL_SESSION_DECODER: OnceLock<Session> = OnceLock::new();
}

pub fn get_encoder(app: &tauri::AppHandle) -> Result<&'static Session, ort::Error> {
  Ok(
    MODEL_SESSION_ENCODER.get_or_init(|| {
      let resource_path = app
        .path()
        .resolve("resources/medsam_encoder.onnx", BaseDirectory::Resource)
        .unwrap();
      println!("Cuda execution provider is available: {:?}", CUDAExecutionProvider::default().is_available());
      Session::builder()
        .unwrap()
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .unwrap()
        .with_intra_threads(6)
        .unwrap()
        .with_execution_providers([
          // Prefer TensorRT over CUDA.
          CUDAExecutionProvider::default().build(),

          TensorRTExecutionProvider::default().build(),
          // Use DirectML on Windows if NVIDIA EPs are not available
          DirectMLExecutionProvider::default().build(),
          // Or use ANE on Apple platforms
          CoreMLExecutionProvider::default().build(),
        ]).unwrap()
        .commit_from_file(resource_path)
        .unwrap()
    })
  )
}

pub fn get_decoder(app: &tauri::AppHandle) -> Result<&'static Session, ort::Error> {
  Ok(
    MODEL_SESSION_DECODER.get_or_init(|| {
      let resource_path = app
        .path()
        .resolve("resources/medsam_decoder.onnx", BaseDirectory::Resource)
        .unwrap();
      Session::builder()
        .unwrap()
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .unwrap()
        .with_intra_threads(4)
        .unwrap()
        .with_execution_providers([
          // Prefer TensorRT over CUDA.
          CUDAExecutionProvider::default().build(),

          TensorRTExecutionProvider::default().build(),
          // Use DirectML on Windows if NVIDIA EPs are not available
          DirectMLExecutionProvider::default().build(),
          // Or use ANE on Apple platforms
          CoreMLExecutionProvider::default().build(),
        ]).unwrap()
        .commit_from_file(resource_path)
        .unwrap()
    })
  )
}
