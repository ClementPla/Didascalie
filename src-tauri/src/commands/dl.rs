use std::sync::{ Arc, Mutex };

use base64::decode;
use tauri::State;
use tauri::{ self, ipc::Response };
use ort::{ self, session::SessionOutputs };
use ort::value::Tensor;

use crate::dl::model::{ get_encoder, get_decoder };
use crate::dl::feature_extract::FeaturesExtractor;

#[tauri::command]
pub fn sam_segment(
  image: Vec<u8>,
  coarse_mask: Vec<u8>,
  threshold: f32,
  width: usize,
  height: usize,
  extract_features: bool,
  max_depth: u32,
  min_size: u32,
  app: tauri::AppHandle,
  features_extractor: State<Arc<Mutex<FeaturesExtractor>>>
) -> Result<Response, String> {

  let mut features_extractor = features_extractor.lock().unwrap();
  if extract_features {
    let image: ort::value::Value<ort::value::TensorValueType<f32>> = features_extractor.prepare_image(
      image,
      width as usize,
      height as usize
    );
    let encoder: &ort::session::Session = get_encoder(&app).map_err(|e|
      format!("Failed to load encoder model: {}", e)
    )?;

    let _ = features_extractor.extract_features(image, &encoder);
  }

  let bbox_and_colors: (
    ndarray::ArrayBase<ndarray::OwnedRepr<f32>, ndarray::Dim<[usize; 3]>>,
    [u8; 4],
  ) = features_extractor.extract_bbox_and_color_from_mask(
    coarse_mask,
    width,
    height,
    max_depth,
    min_size
  );

  let bbox_array: ndarray::ArrayBase<
    ndarray::OwnedRepr<f32>,
    ndarray::Dim<[usize; 3]>
  > = bbox_and_colors.0;

  if bbox_array.dim().0 == 0 {
    return Ok(Response::new(Vec::new()));
  }
  let bbox_tensor: ort::value::Value<ort::value::TensorValueType<f32>> = Tensor::from_array(
    bbox_array.clone()
  ).unwrap();
  let color: [u8; 4] = bbox_and_colors.1;

  // Load model
  let decoder: &ort::session::Session = get_decoder(&app).map_err(|e|
    format!("Failed to load decoder model: {}", e)
  )?;

  let mut decoder_binding = decoder.create_binding().unwrap();
  decoder_binding.bind_input("features", features_extractor.get_features()).unwrap();
  decoder_binding.bind_input("bbox", &bbox_tensor).unwrap();

  decoder_binding.bind_output_to_device("mask", &decoder.allocator().memory_info()).unwrap();
  decoder_binding.synchronize_inputs().unwrap();
  println!("Running decoder inference");
  let mut outputs = decoder_binding.run().map_err(|e| e.to_string())?;
  let binding = outputs.remove("mask").unwrap();
  let output = binding
    .try_extract_tensor::<f32>().map_err(|e| e.to_string())?;
  
  // Convert the output tensor directly to a 2D view and create the image buffer in one pass
  let output_mask_image: image::DynamicImage = image::DynamicImage::ImageRgba8(
    image::ImageBuffer::from_fn(1024, 1024, |x, y| {
      let value = *output.get([y as usize, x as usize]).unwrap() > threshold;
      if value {
        image::Rgba(color)
      } else {
        image::Rgba([0, 0, 0, 0])
      }
    })
  );

  let output_mask_image = output_mask_image.resize_exact(
    width as u32,
    height as u32,
    image::imageops::FilterType::Nearest
  );

  Ok(Response::new(output_mask_image.to_rgba8().into_vec()))
}
