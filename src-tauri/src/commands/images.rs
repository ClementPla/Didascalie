use base64::{engine::general_purpose, Engine as _};
use std;

use image::{ImageBuffer, Luma, Rgb, Rgba};
use std::io::Cursor;
use std::path::{Path, PathBuf};

use image::{DynamicImage, GenericImageView};
use ndarray::{Array2, Array3, ArrayView3};

use tauri::ipc::Response;

#[tauri::command]
pub async fn create_cache_thumbnail(
    image_path: String,
    thumbnail_path: String,
    width: u32,
    height: u32,
) -> Result<bool, String> {
    let image_path = Path::new(&image_path).to_path_buf();
    let thumbnail_path = Path::new(&thumbnail_path).to_path_buf();
    Ok(generate_thumbnail(
        &image_path,
        &thumbnail_path,
        width,
        height,
    ))
}

#[tauri::command]
pub async fn create_thumbnail(
    image_path: String,
    width: u32,
    height: u32,
) -> Result<String, String> {
    let image_path = Path::new(&image_path).to_path_buf();
    let img = image::open(&image_path).unwrap();
    let thumbnail = img.thumbnail(width, height);
    // Return the thumbnail as a base64 string
    let mut buffer = Cursor::new(Vec::new());
    thumbnail
        .write_to(&mut buffer, image::ImageFormat::Png)
        .unwrap();
    let thumbnail_base64 = general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(thumbnail_base64)
}

#[tauri::command]
pub fn load_image_as_base64(filepath: String) -> Result<Response, String> {
    let image_path = Path::new(&filepath);

    if !image_path.exists() {
        eprintln!("Image {} does not exist", image_path.display());
        return Err(format!("Image does not exist: {}", image_path.display()));
    }

    // Open the image
    let img = image::open(image_path).map_err(|err| {
        eprintln!("Failed to open image: {}", err);
        format!("Failed to open image: {}", err)
    })?;

    // Create a buffer wrapped in a Cursor
    let mut buffer = Cursor::new(Vec::new());

    // Write the image to the buffer
    img.write_to(&mut buffer, image::ImageFormat::Png)
        .map_err(|err| {
            eprintln!("Failed to write image to buffer: {}", err);
            format!("Failed to write image to buffer: {}", err)
        })?;

    Ok(Response::new(buffer.into_inner()))
}

fn generate_thumbnail(
    image_path: &PathBuf,
    thumbnail_path: &PathBuf,
    width: u32,
    height: u32,
) -> bool {
    let image_path = image_path.clone();
    let thumbnail_path = thumbnail_path.clone();

    let img = image::open(&image_path).unwrap();
    let thumbnail = img.thumbnail(width, height);
    if !thumbnail_path.parent().unwrap().exists() {
        std::fs::create_dir_all(thumbnail_path.parent().unwrap()).unwrap();
    }
    if thumbnail_path.exists() {
        return true;
    }
    thumbnail.save(&thumbnail_path).is_ok()
}

#[tauri::command]
pub fn process_image_blob(blob: Vec<u8>) -> Result<f64, String> {
    // Convert the blob to an image
    let img = match image::load_from_memory(&blob) {
        Ok(dynamic_image) => dynamic_image.to_rgba8(),
        Err(_) => return Err("Failed to load image from blob".to_string()),
    };

    // Calculate mean pixel value
    let (width, height) = img.dimensions();
    let total_pixels = width * height;

    // Sum up all pixel values
    let sum: f64 = img
        .pixels()
        .map(|pixel| {
            // Calculate average of R, G, B channels (ignore alpha)
            (pixel[0] as f64 + pixel[1] as f64 + pixel[2] as f64) / 3.0
        })
        .sum();

    // Calculate mean
    let mean = sum / (total_pixels as f64);

    Ok(mean)
}

pub fn convert_rgb_to_blob(rgb: &ArrayView3<u8>) -> Result<Vec<u8>, String> {
    let (height, width, _channel) = rgb.dim();

    // Create an image buffer from the RGB array
    let rgb_image: ImageBuffer<Rgba<u8>, Vec<u8>> =
        ImageBuffer::from_fn(width as u32, height as u32, |x, y| {
            let r = rgb[[y as usize, x as usize, 0 as usize]];
            let g = rgb[[y as usize, x as usize, 1 as usize]];
            let b = rgb[[y as usize, x as usize, 2 as usize]];
            // if
            Rgba([r, g, b, 255])
        });

    // Convert to PNG blob
    let mut blob = Vec::new();
    let mut cursor = Cursor::new(&mut blob);
    rgb_image
        .write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|_| "Failed to convert RGB to blob".to_string())?;

    Ok(blob)
}

pub fn load_blob_to_image(blob: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory(blob).map_err(|_| "Failed to load image from blob".to_string())
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

pub fn convert_image_to_rgb_u8_array(image: &DynamicImage) -> Array3<u8> {
    let (width, height) = image.dimensions();
    let rgb_image = image.to_rgb8();
    let pixels = rgb_image.into_raw();

    Array3::from_shape_vec((height as usize, width as usize, 3 as usize), pixels).unwrap()
}

pub fn hex_to_rgb(hex: String) -> Vec<u8> {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap();
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap();
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap();
    vec![r, g, b]
}

pub fn filter_aliasing(
    image: ImageBuffer<image::Rgba<u8>, Vec<u8>>,
    hex: String,
) -> ImageBuffer<image::Rgb<u8>, Vec<u8>> {
    let color = hex_to_rgb(hex);
    // Any time alpha is not 0, we take
    let mut new_image: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::new(image.width(), image.height());
    for y in 0..image.height() {
        for x in 0..image.width() {
            let pixel = image.get_pixel(x, y);
            let mut new_pixel = Rgb([0, 0, 0]);
            if pixel[3] != 0 {
                new_pixel[0] = color[0];
                new_pixel[1] = color[1];
                new_pixel[2] = color[2];
            }
            new_image.put_pixel(x, y, new_pixel);
        }
    }
    new_image
}

pub fn merge_multiple_images(
    images: &Vec<ImageBuffer<image::Rgb<u8>, Vec<u8>>>,
) -> ImageBuffer<image::Rgb<u8>, Vec<u8>> {
    let mut new_image: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::new(images[0].width(), images[0].height());
    for y in 0..images[0].height() {
        for x in 0..images[0].width() {
            let mut new_pixel = Rgb([0, 0, 0]);
            for image in images.iter().rev() {
                let pixel = image.get_pixel(x, y);
                if (pixel[0] != 0) || (pixel[1] != 0) || (pixel[2] != 0) {
                    new_pixel[0] = pixel[0];
                    new_pixel[1] = pixel[1];
                    new_pixel[2] = pixel[2];
                }
            }
            new_image.put_pixel(x, y, new_pixel);
        }
    }
    new_image
}

pub fn from_rgb_to_binary(
    image: &ImageBuffer<image::Rgb<u8>, Vec<u8>>,
) -> ImageBuffer<image::Luma<u8>, Vec<u8>> {
    let (width, height) = image.dimensions();
    let mut mask_data: ImageBuffer<image::Luma<u8>, Vec<u8>> = ImageBuffer::new(width, height);

    for y in 0..height {
        for x in 0..width {
            let pixel = image.get_pixel(x, y);
            let is_masked = (pixel[0] != 0) || (pixel[1] != 0) || (pixel[2] != 0);
            if is_masked {
                mask_data.put_pixel(x, y, image::Luma([255]));
            } else {
                mask_data.put_pixel(x, y, image::Luma([0]));
            }
        }
    }
    mask_data
}

pub fn from_multiples_masks_to_multiclass(
    masks: &Vec<ImageBuffer<image::Luma<u8>, Vec<u8>>>,
) -> ImageBuffer<image::Luma<u8>, Vec<u8>> {
    let (width, height) = masks[0].dimensions();
    let mut mask_data: ImageBuffer<image::Luma<u8>, Vec<u8>> = ImageBuffer::new(width, height);

    for y in 0..height {
        for x in 0..width {
            let mut new_pixel = Luma([0]);
            for (i, mask) in masks.iter().enumerate().rev() {
                let pixel = mask.get_pixel(x, y);
                if pixel[0] != 0 {
                    new_pixel = Luma([i as u8]);
                }
            }
            mask_data.put_pixel(x, y, new_pixel);
        }
    }
    mask_data
}
