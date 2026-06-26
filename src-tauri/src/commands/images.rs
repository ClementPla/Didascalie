use base64::{engine::general_purpose, Engine as _};
use std;

use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{DynamicImage, GenericImageView};
use ndarray::Array2;

#[tauri::command]
pub async fn create_cache_thumbnail(
    image_path: String,
    thumbnail_path: String,
    width: u32,
    height: u32,
) -> Result<bool, String> {
    let image_path = Path::new(&image_path).to_path_buf();
    let thumbnail_path = Path::new(&thumbnail_path).to_path_buf();
    if thumbnail_path.exists() {
        // If the thumbnail already exists, return true
        return Ok(true);
    }
    generate_thumbnail(
        &image_path,
        &thumbnail_path,
        width,
        height,
    )
}

#[tauri::command]
pub async fn create_thumbnail(
    image_path: String,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let image_path = Path::new(&image_path).to_path_buf();
    let img = image::open(&image_path)
        .map_err(|e| format!("Failed to open image '{}': {}", image_path.display(), e))?;
    let thumbnail = img.thumbnail(width, height);
    // Return the thumbnail as a base64 string
    let mut buffer = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode thumbnail: {}", e))?;
    let thumbnail_base64 = general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(thumbnail_base64)
}

#[tauri::command]
pub fn load_image_as_base64(filepath: String) -> Result<String, String> {
    let image_path = Path::new(&filepath);

    if !image_path.exists() {
        return Err(format!("Image does not exist: {}", image_path.display()));
    }

    // Read the file as raw bytes (no decoding/encoding)
    let image_bytes =
        std::fs::read(image_path).map_err(|err| format!("Failed to read image file: {}", err))?;

    // Detect MIME type from file extension or magic bytes
    let mime_type = detect_mime_type(image_path, &image_bytes);

    // Encode to base64
    let base64_string = general_purpose::STANDARD.encode(&image_bytes);

    // Return as data URL
    Ok(format!("data:{};base64,{}", mime_type, base64_string))
}

fn detect_mime_type(path: &Path, bytes: &[u8]) -> &'static str {
    // Check magic bytes first (more reliable)
    if bytes.len() >= 4 {
        match &bytes[0..4] {
            [0x89, b'P', b'N', b'G'] => return "image/png",
            [0xFF, 0xD8, 0xFF, _] => return "image/jpeg",
            _ => {}
        }
    }

    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }

    // Fallback to extension
    match path.extension().and_then(|s| s.to_str()) {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("bmp") => "image/bmp",
        _ => "application/octet-stream",
    }
}

fn generate_thumbnail(
    image_path: &PathBuf,
    thumbnail_path: &PathBuf,
    width: u32,
    height: u32,
) -> Result<bool, String> {
    let img = image::open(image_path)
        .map_err(|e| format!("Failed to open image '{}': {}", image_path.display(), e))?;
    let thumbnail = img.thumbnail(width, height);

    if let Some(parent) = thumbnail_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create thumbnail directory: {}", e))?;
        }
    }
    if thumbnail_path.exists() {
        return Ok(true);
    }
    thumbnail
        .save(thumbnail_path)
        .map_err(|e| format!("Failed to save thumbnail: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub fn process_image_blob(blob: Vec<u8>) -> Result<f64, String> {
    // Convert the blob to an image
    let img = match image::load_from_memory(&blob) {
        Ok(dynamic_image) => dynamic_image.to_rgba8(),
        Err(_) => {
            return Err("Failed to load image from blob".to_string());
        }
    };

    // Calculate mean pixel value
    let (width, height) = img.dimensions();
    let total_pixels = width * height;

    // Sum up all pixel values
    let sum: f64 = img
        .pixels()
        .map(|pixel| {
            // Calculate average of R, G, B channels (ignore alpha)
            ((pixel[0] as f64) + (pixel[1] as f64) + (pixel[2] as f64)) / 3.0
        })
        .sum();

    // Calculate mean
    let mean = sum / (total_pixels as f64);

    Ok(mean)
}

pub fn convert_image_to_mask_array(image: &DynamicImage) -> Array2<bool> {
    let (width, height) = image.dimensions();
    let rgba_image = image.to_rgba8();
    let pixels = rgba_image.into_raw();

    let mut mask_data = Vec::with_capacity((width * height) as usize);

    for pixel in pixels.chunks(4) {
        let a = pixel[3];
        // Binarization using the alpha channel
        let is_masked = a > 128;

        mask_data.push(is_masked);
    }

    Array2::from_shape_vec((height as usize, width as usize), mask_data).unwrap()
}

pub fn convert_image_to_luma_u8_array(image: &DynamicImage) -> Array2<u8> {
    let (width, height) = image.dimensions();
    let luma_image = image.to_luma8();
    let pixels = luma_image.into_raw();

    Array2::from_shape_vec((height as usize, width as usize), pixels).unwrap()
}
