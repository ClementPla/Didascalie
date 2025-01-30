use std::sync::{Arc, Mutex};

use crate::dl::feature_extract::FeaturesExtractor;
use crate::dl::model::{get_decoder, get_encoder};
use ort::value::Tensor;
use ort::{self};
use tauri::State;
use tauri::{self, ipc::Response};

use ndarray::Array4;
use rayon::prelude::*;

#[tauri::command]
pub fn mask_sam_segment<'a>(
    image: Vec<u8>,
    coarse_mask: Vec<bool>,
    threshold: f32,
    width: usize,
    height: usize,
    extract_features: bool,
    app: tauri::AppHandle,
    features_extractor: State<'a, Arc<Mutex<FeaturesExtractor>>>,
) -> Result<Response, String> {
    let start_time = std::time::Instant::now();

    let mut features_extractor = features_extractor.lock().unwrap();
    if extract_features {
        let prepare_start = std::time::Instant::now();
        let image: ort::value::Value<ort::value::TensorValueType<f32>> =
            features_extractor.prepare_image(image, width as usize, height as usize);
        println!("Image preparation took: {:?}", prepare_start.elapsed());

        let encoder: &ort::session::Session =
            get_encoder(&app, "resources/maskedMedSAM/image_extractor.onnx")
                .map_err(|e| format!("Failed to load encoder model: {}", e))?;

        let encode_start = std::time::Instant::now();
        let _ = features_extractor.extract_features(image, &encoder);
        println!("Feature extraction took: {:?}", encode_start.elapsed());
    }

    // Create data vector using parallel iteration
    let data: Vec<f32> = coarse_mask
        .par_iter()
        .map(|&pixel: &bool| if pixel { 1.0f32 } else { 0.0f32 })
        .collect();

    let mask_tensor = Tensor::from_array(
        Array4::from_shape_vec((1, 1, 1024, 1024), data).map_err(|e| e.to_string())?,
    )
    .unwrap();

    let decoder_start = std::time::Instant::now();
    let decoder: &ort::session::Session = get_decoder(&app, "resources/maskedMedSAM/decoder.onnx")
        .map_err(|e| format!("Failed to load decoder model: {}", e))?;

    let mut decoder_binding = decoder.create_binding().unwrap();
    decoder_binding
        .bind_input("features", features_extractor.get_features())
        .unwrap();
    decoder_binding
        .bind_input("coarseMasks", &mask_tensor)
        .unwrap();

    decoder_binding
        .bind_output_to_device("masks", &decoder.allocator().memory_info())
        .unwrap();
    decoder_binding.synchronize_inputs().unwrap();
    println!("Decoder setup took: {:?}", decoder_start.elapsed());

    let inference_start = std::time::Instant::now();
    let mut outputs = decoder_binding.run().map_err(|e| e.to_string())?;
    println!("Decoder inference took: {:?}", inference_start.elapsed());

    let binding = outputs.remove("masks").unwrap();
    let output = binding
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    // Ensure output tensor has the correct shape
    let output = output.view();

    let binary = output.mapv(|x| (x > threshold) as u8);
    let binary_vec: Vec<u8> = binary.into_raw_vec_and_offset().0;

    // No need to convert back to DynamicImage

    println!("Total execution time: {:?}", start_time.elapsed());
    Ok(Response::new(binary_vec))
}
