use tauri::Manager;
use tauri::{ self, ipc::Response, path::BaseDirectory };
use ort::{ self, session::SessionOutputs };
use ort::execution_providers::CUDAExecutionProvider;
use image::GenericImageView;
use ort::session::{ builder::GraphOptimizationLevel, Session, SessionInputValue };
use ndarray::{ Array, Array2 };
use ort::value::Tensor;
use super::images::load_blob_to_image;
use std::io::Cursor;

use std::sync::OnceLock;
use lazy_static::lazy_static;

// Optional: Create a thread-safe singleton for the model
lazy_static! {
  static ref MODEL_SESSION: OnceLock<Session> = OnceLock::new();
}

fn get_or_create_model(app: &tauri::AppHandle) -> Result<&'static Session, ort::Error> {
  Ok(
    MODEL_SESSION.get_or_init(|| {
      // First, create the CUDA execution provider
      let cuda_provider = CUDAExecutionProvider::default();

      let resource_path = app.path().resolve("resources/medsam.onnx", BaseDirectory::Resource).unwrap();

      Session::builder()
        .unwrap()
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .unwrap()
        .with_intra_threads(4)
        .unwrap()
        // Try using .with_provider() instead
        .with_execution_providers(vec![cuda_provider.into()])
        .unwrap()
        .commit_from_file(resource_path)
        .unwrap()
    })
  )
}

#[tauri::command]
pub fn sam_segment(app: tauri::AppHandle, image: Vec<u8>, coarse_mask: Vec<u8>, threshold: f32) -> Result<Response, String> {
  // ort::init()
  // 	.with_execution_providers([CUDAExecutionProvider::default().build().error_on_failure()])
  // .commit().map_err(|e| e.to_string())?;

  let model = get_or_create_model(&app).map_err(|e| format!("Model loading failed: {}", e))?;
  let expected_size = 256;
  let image = load_blob_to_image(&image).unwrap();
  let coarse_mask = load_blob_to_image(&coarse_mask).unwrap();

  // Get size
  let (width, height) = image.dimensions();

  // Find min and max pixel value (all channels combined)


  // Resize image to 1024x1024
  let image = image.resize_exact(expected_size, expected_size, image::imageops::FilterType::Nearest);
  let coarse_mask = coarse_mask.resize_exact(expected_size, expected_size, image::imageops::FilterType::Nearest);

  // Convert image to tensor
  let mut image_array = Array::zeros([1, 3, expected_size as usize, expected_size as usize]);
  let mut bbox_array = Array::zeros((1, 1, 4));

  // Convert image to normalized array using parallel iterator
  let pixels: Vec<_> = image.pixels().collect();
  pixels.iter().for_each(|pixel| {
    let x = pixel.0 as usize;
    let y = pixel.1 as usize;
    let [r, g, b, _] = pixel.2.0;
    let norm = 1.0 / 255.0;
    image_array[[0, 0, y, x]] = (r as f32) * norm;
    image_array[[0, 1, y, x]] = (g as f32) * norm;
    image_array[[0, 2, y, x]] = (b as f32) * norm;
  });

  // Find bounding box and color in single pass
  let mask_pixels: Vec<_> = coarse_mask.pixels().collect();
  let (color, bounds) = mask_pixels.iter()
    .filter(|p| p.2.0[0] > 0)
    .fold(
      ([255, 255, 255, 255], (expected_size, expected_size, 0, 0)),
      |acc, p| {
        let (_, _, [r, g, b, a], (mut xmin, mut ymin, mut xmax, mut ymax)) = 
          (p.0, p.1, p.2.0, acc.1);
        xmin = xmin.min(p.0);
        ymin = ymin.min(p.1);
        xmax = xmax.max(p.0);
        ymax = ymax.max(p.1);
        ([r, g, b, a], (xmin, ymin, xmax, ymax))
      }
    );

  let (xmin, ymin, xmax, ymax) = bounds;

  bbox_array[[0, 0, 0]] = xmin as f32;
  bbox_array[[0, 0, 1]] = ymin as f32;
  bbox_array[[0, 0, 2]] = xmax as f32;
  bbox_array[[0, 0, 3]] = ymax as f32;

  // Convert image array to a Tensor
  let image_value = Tensor::from_array(image_array).unwrap();
  let mask_value = Tensor::from_array(bbox_array).unwrap();

  // Load model
  let data: Vec<(&str, SessionInputValue)> = vec![
    ("images".into(), SessionInputValue::from(image_value)),
    ("bbox".into(), SessionInputValue::from(mask_value))
  ];
  println!("Running model inference");
  let outputs: SessionOutputs = model.run(data).expect("Failed to run model inference");
  let output: ndarray::ArrayBase<
    ndarray::ViewRepr<&f32>,
    ndarray::Dim<ndarray::IxDynImpl>
  > = outputs["output_masks"].try_extract_tensor().unwrap();

  // Display a message

  println!("Model ran successfully");

  // Convert the output tensor directly to a 2D view and create the image buffer in one pass
  let output_mask_image = image::DynamicImage::ImageRgba8(
    image::ImageBuffer::from_fn(expected_size, expected_size, |x, y| {
      let value = *output.get([y as usize, x as usize]).unwrap() > threshold;
      if value {
        image::Rgba(color)
      } else {
        image::Rgba([0, 0, 0, 0])
      }
    })
  );

  let output_mask_image = output_mask_image.resize_exact(
    width,
    height,
    image::imageops::FilterType::CatmullRom,
  );

  let mut blob = Vec::new();
  let mut cursor = Cursor::new(&mut blob);
  output_mask_image
    .write_to(&mut cursor, image::ImageFormat::Png)
    .map_err(|_| "Failed to convert mask to blob".to_string())?;

  Ok(Response::new(blob))
}
