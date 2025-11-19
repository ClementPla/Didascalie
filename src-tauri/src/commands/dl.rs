use crate::dl::feature_extract::FeaturesExtractor;
use crate::dl::model::{get_decoder_async, get_encoder_async, ModelSessions};
use ndarray::Array4;
use ort::{self, value::Tensor};
use std::sync::Arc;
use tauri::State;
use tauri::{self, ipc::Response};
use tokio::sync::Mutex;

#[tauri::command]
pub async fn mask_sam_segment<'a>(
    image: Vec<u8>,
    coarse_mask: Vec<bool>,
    threshold: f32,
    width: usize,
    height: usize,
    extract_features: bool,
    app: tauri::AppHandle,
    features_extractor: State<'a, Arc<Mutex<FeaturesExtractor>>>,
    model_sessions: State<'a, ModelSessions>,
) -> Result<Response, String> {
    let start_time = std::time::Instant::now();

    if extract_features {
        let prepare_start = std::time::Instant::now();

        let image_tensor = {
            let features_extractor_guard = features_extractor.lock().await;
            features_extractor_guard.prepare_image(image.clone(), width, height)
        };

        println!("Image preparation took: {:?}", prepare_start.elapsed());

        let encoder = get_encoder_async(&app, &model_sessions).await?;
        let mut encoder_guard = encoder.lock().await;

        let encode_start = std::time::Instant::now();

        let mut features_extractor_guard = features_extractor.lock().await;
        features_extractor_guard
            .__extract_features__(image_tensor, &mut *encoder_guard)
            .map_err(|e| format!("Feature extraction failed: {}", e))?;

        println!("Feature extraction took: {:?}", encode_start.elapsed());
    }

    // Convert coarse mask to image, resize to 1024x1024
    let gray_image = image::GrayImage::from_raw(
        width as u32,
        height as u32,
        coarse_mask
            .clone()
            .into_iter()
            .map(|b| if b { 255u8 } else { 0u8 })
            .collect::<Vec<u8>>(),
    )
    .unwrap();

    let resized_image = image::imageops::resize(
        &gray_image,
        1024,
        1024,
        image::imageops::FilterType::CatmullRom,
    );
    let mask = image::DynamicImage::ImageLuma8(resized_image);

    // Convert image to data vector
    let mask = mask.to_luma32f();
    let data = mask.into_raw();

    let mask_tensor = Tensor::from_array(
        Array4::from_shape_vec((1, 1, 1024, 1024), data).map_err(|e| e.to_string())?,
    )
    .unwrap();

    let decoder_start = std::time::Instant::now();
    let decoder = get_decoder_async(&app, &model_sessions).await?;
    let mut decoder_guard = decoder.lock().await;

    let features_extractor_guard = features_extractor.lock().await;

    let mut __decoder_binding__ = decoder_guard.create_binding().unwrap();
    __decoder_binding__
        .bind_input("features", features_extractor_guard.get_features())
        .unwrap();
    __decoder_binding__
        .bind_input("coarseMasks", &mask_tensor)
        .unwrap();
    __decoder_binding__
        .bind_output_to_device("masks", &decoder_guard.allocator().memory_info())
        .unwrap();
    __decoder_binding__.synchronize_inputs().unwrap();
    println!("Decoder setup took: {:?}", decoder_start.elapsed());

    let inference_start = std::time::Instant::now();
    let outputs = decoder_guard
        .run_binding(&__decoder_binding__)
        .map_err(|e| e.to_string())?;
    println!("Decoder inference took: {:?}", inference_start.elapsed());
    drop(features_extractor_guard);

    let binding = outputs.get("masks").ok_or("No output named 'masks'")?;
    let (shape, data) = binding
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    // The output is already 2D [1024, 1024], not 4D
    let output =
        ndarray::ArrayView2::<f32>::from_shape((shape[0] as usize, shape[1] as usize), data)
            .map_err(|e| format!("Shape error: {}", e))?;

    // Apply threshold
    let binary = output.mapv(|x| (x > threshold) as u8);

    // Resize binary mask to original size
    let binary = image::imageops::resize(
        &image::GrayImage::from_raw(1024, 1024, binary.into_raw_vec_and_offset().0)
            .ok_or("Failed to create gray image")?,
        width as u32,
        height as u32,
        image::imageops::FilterType::Nearest,
    );

    let binary_vec: Vec<u8> = binary.into_raw();
    println!("Total execution time: {:?}", start_time.elapsed());

    Ok(Response::new(binary_vec))
}
