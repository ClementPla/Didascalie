use std::sync::{Arc, Mutex};

use crate::dl::feature_extract::FeaturesExtractor;
use crate::dl::model::{get_decoder, get_encoder};
use image::buffer::ConvertBuffer;
use image::GenericImageView;
use ort::value::Tensor;
use ort::{self};
use tauri::State;
use tauri::{self, ipc::Response};

use image::{GrayImage, RgbaImage};
use ndarray::Array4;
use rayon::prelude::*;

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
    features_extractor: State<Arc<Mutex<FeaturesExtractor>>>,
) -> Result<Response, String> {
    let mut features_extractor = features_extractor.lock().unwrap();
    if extract_features {
        let image: ort::value::Value<ort::value::TensorValueType<f32>> =
            features_extractor.prepare_image(image, width as usize, height as usize);
        let encoder: &ort::session::Session = get_encoder(&app, "resources/medsam_encoder.onnx")
            .map_err(|e| format!("Failed to load encoder model: {}", e))?;

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
        min_size,
    );

    let bbox_array: ndarray::ArrayBase<ndarray::OwnedRepr<f32>, ndarray::Dim<[usize; 3]>> =
        bbox_and_colors.0;

    if bbox_array.dim().0 == 0 {
        return Ok(Response::new(Vec::new()));
    }
    let bbox_tensor: ort::value::Value<ort::value::TensorValueType<f32>> =
        Tensor::from_array(bbox_array.clone()).unwrap();
    let color: [u8; 4] = bbox_and_colors.1;

    // Load model
    let decoder: &ort::session::Session = get_decoder(&app, "resources/medsam_decoder.onnx")
        .map_err(|e| format!("Failed to load decoder model: {}", e))?;

    let mut decoder_binding = decoder.create_binding().unwrap();
    decoder_binding
        .bind_input("features", features_extractor.get_features())
        .unwrap();
    decoder_binding.bind_input("bbox", &bbox_tensor).unwrap();

    decoder_binding
        .bind_output_to_device("mask", &decoder.allocator().memory_info())
        .unwrap();
    decoder_binding.synchronize_inputs().unwrap();
    println!("Running decoder inference");
    let mut outputs = decoder_binding.run().map_err(|e| e.to_string())?;
    let binding = outputs.remove("mask").unwrap();
    let output = binding
        .try_extract_tensor::<f32>()
        .map_err(|e| e.to_string())?;

    // Convert the output tensor directly to a 2D view and create the image buffer in one pass
    let output_mask_image: image::DynamicImage =
        image::DynamicImage::ImageRgba8(image::ImageBuffer::from_fn(1024, 1024, |x, y| {
            let value = *output.get([y as usize, x as usize]).unwrap() > threshold;
            if value {
                image::Rgba(color)
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        }));

    let output_mask_image = output_mask_image.resize_exact(
        width as u32,
        height as u32,
        image::imageops::FilterType::Nearest,
    );

    Ok(Response::new(output_mask_image.to_rgba8().into_vec()))
}

fn rgba_to_gray_parallel(rgba: &RgbaImage) -> GrayImage {
    let (width, height) = rgba.dimensions();
    let mut gray = GrayImage::new(width, height);

    // Access the raw buffers
    let rgba_buf = rgba.as_raw();
    let gray_buf = gray.as_mut();

    // Process in parallel
    gray_buf
        .par_iter_mut()
        .enumerate()
        .for_each(|(i, gray_pixel)| {
            let rgba_index = i * 4;
            let a = rgba_buf[rgba_index + 3];
            if a > 0 {
                *gray_pixel = 255;
                return;
            }
            // Luminance formula
        });

    gray
}

#[tauri::command]
pub fn mask_sam_segment<'a>(
    image: Vec<u8>,
    coarse_mask: Vec<u8>,
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

    let mask_prep_start = std::time::Instant::now();
    let mut mask = RgbaImage::from_raw(width as u32, height as u32, coarse_mask)
        .ok_or("Failed to create RgbaImage")?;

    // Convert to grayscale and resize
    let graymask = rgba_to_gray_parallel(&mask);
    let resized_graymask =
        image::imageops::resize(&graymask, 256, 256, image::imageops::FilterType::Nearest);

    // Sequentially find the first pixel with a non-zero red channel
    let color = mask
        .pixels()
        .find(|pixel| pixel[0] > 0)
        .map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
        .unwrap_or([0, 0, 0, 0]);

    // Create data vector using parallel iteration
    let data: Vec<f32> = resized_graymask
        .as_raw()
        .par_iter()
        .map(|&pixel: &u8| if pixel > 0 { 1.0f32 } else { 0.0f32 })
        .collect();

    let mask_tensor = Tensor::from_array(
        Array4::from_shape_vec((1, 1, 256, 256), data).map_err(|e| e.to_string())?,
    )
    .unwrap();

    println!("Mask preparation took: {:?}", mask_prep_start.elapsed());

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
    let postprocess_start = std::time::Instant::now();

    // Ensure output tensor has the correct shape
    let output = output.view();

    // Parallelize the iteration over pixels
    mask.par_chunks_mut(4).enumerate().for_each(|(i, pixel)| {
        let x = (i % width) as usize;
        let y = (i / width) as usize;
        if output[[y, x]] > threshold {
            pixel.copy_from_slice(&color);
        } else {
            pixel.copy_from_slice(&[0, 0, 0, 0]);
        }
    });

    // No need to convert back to DynamicImage

    println!("Post-processing took: {:?}", postprocess_start.elapsed());

    println!("Total execution time: {:?}", start_time.elapsed());
    Ok(Response::new(mask.into_vec()))
}
