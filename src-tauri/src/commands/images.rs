use std;

use std::path::{Path, PathBuf};
use std::io::Cursor;
use image::{ImageBuffer, Rgba};

use image::{GenericImageView, DynamicImage};
use ndarray::{Array2, Array3, ArrayView3};

use tauri::ipc::Response;



#[tauri::command]
pub async fn create_thumbnail(image_path: String, thumbnail_path: String, width: u32, height: u32) -> Result<bool, String> {
    let image_path = Path::new(&image_path).to_path_buf();   
    let thumbnail_path = Path::new(&thumbnail_path).to_path_buf();
    Ok(generate_thumbnail(&image_path, &thumbnail_path, width, height))
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
    img.write_to(&mut buffer, image::ImageFormat::Png).map_err(|err| {
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
    
    std::thread::spawn(move || {
        let img = image::open(&image_path).unwrap();
        let thumbnail = img.thumbnail(width, height);
        if !thumbnail_path.parent().unwrap().exists() {
            std::fs::create_dir_all(thumbnail_path.parent().unwrap()).unwrap();
        }
        if thumbnail_path.exists() {
            return true;
        }
        thumbnail.save(&thumbnail_path).is_ok()
    }).join().unwrap_or(false)
}



#[tauri::command]
pub fn process_image_blob(blob: Vec<u8>) -> Result<f64, String> {
    // Convert the blob to an image
    let img = match image::load_from_memory(&blob) {
        Ok(dynamic_image) => dynamic_image.to_rgba8(),
        Err(_) => return Err("Failed to load image from blob".to_string())
    };

    // Calculate mean pixel value
    let (width, height) = img.dimensions();
    let total_pixels = width * height;
    
    // Sum up all pixel values
    let sum: f64 = img.pixels()
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
    let (height, width, _channel ) = rgb.dim();
    
    // Create an image buffer from the RGB array
    let rgb_image: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::from_fn(
        width as u32, 
        height as u32, 
        |x, y| {
            let r = rgb[[y as usize, x as usize, 0 as usize]];
            let g = rgb[[y as usize, x as usize, 1 as usize]];
            let b = rgb[[y as usize, x as usize, 2 as usize]];
            // if 
            Rgba([r, g, b, 255])
        }
    );
    
    // Convert to PNG blob
    let mut blob = Vec::new();
    let mut cursor = Cursor::new(&mut blob);
    rgb_image.write_to(&mut cursor, image::ImageFormat::Png)
        .map_err(|_| "Failed to convert RGB to blob".to_string())?;
    
    Ok(blob)
}


pub fn load_blob_to_image(blob: &[u8]) -> Result<DynamicImage, String> {
    image::load_from_memory(blob)
        .map_err(|_| "Failed to load image from blob".to_string())
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

    Array2::from_shape_vec(
        (height as usize, width as usize),
        mask_data,
    ).unwrap()
}

pub fn convert_image_to_luma_u8_array(image: &DynamicImage) -> Array2<u8> {
    let (width, height) = image.dimensions();
    let luma_image = image.to_luma8();
    let pixels = luma_image.into_raw();

    Array2::from_shape_vec(
        (height as usize, width as usize),
        pixels,
    ).unwrap()
}

pub fn convert_image_to_rgb_u8_array(image: &DynamicImage) -> Array3<u8> {
    let (width, height) = image.dimensions();
    let rgb_image = image.to_rgb8();
    let pixels = rgb_image.into_raw();

    Array3::from_shape_vec(
        (height as usize, width as usize, 3 as usize),
        pixels,
    ).unwrap()
}