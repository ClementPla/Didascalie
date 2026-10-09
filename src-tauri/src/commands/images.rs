use image::{DynamicImage, GenericImageView};
use ndarray::Array2;

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
