use super::images::{convert_image_to_luma_u8_array, convert_image_to_mask_array};
use image::{GenericImageView, GrayImage, Luma};
use imageproc::distance_transform::Norm;
use imageproc::morphology::close_mut;
use imageproc::region_labelling::{connected_components, Connectivity};
use itertools::Itertools;
use ndarray::{Array2, Zip};
use std::collections::HashMap;
use tauri::{self, ipc::Response}; // for .into_par_iter()

fn otsu_level(pixels: &Vec<u8>) -> u8 {
    // Step 1: Compute histogram
    let mut histogram = [0u32; 256];
    for &pixel in pixels {
        histogram[pixel as usize] += 1;
    }

    let total_pixels = pixels.len() as f64;

    // Step 2: Compute probabilities
    let mut probability = [0f64; 256];
    for i in 0..256 {
        probability[i] = (histogram[i] as f64) / total_pixels;
    }

    // Initialize variables
    let mut max_between_class_variance = 0.0;
    let mut optimal_threshold = 0u8;

    let mut w0 = 0.0; // Weight for background class
    let mut sum0 = 0.0; // Cumulative sum for background class
    let mut total_mean = 0.0;

    // Compute total mean
    for i in 0..256 {
        total_mean += (i as f64) * probability[i];
    }

    // Step 3: Iterate over possible thresholds
    for t in 0..256 {
        w0 += probability[t];
        if w0 == 0.0 {
            continue;
        }

        let w1 = 1.0 - w0;
        if w1 == 0.0 {
            break;
        }

        sum0 += (t as f64) * probability[t];
        let μ0 = sum0 / w0;
        let μ1 = (total_mean - sum0) / w1;

        // Between-class variance
        let between_class_variance = w0 * w1 * (μ0 - μ1) * (μ0 - μ1);

        // Update maximum variance and threshold
        if between_class_variance > max_between_class_variance {
            max_between_class_variance = between_class_variance;
            optimal_threshold = t as u8;
        }
    }

    optimal_threshold
}

fn otsu_in_mask(
    image: &Array2<u8>,
    mask: &Array2<bool>,
    inverse: bool,
) -> Result<Array2<bool>, String> {
    // Ensure the image and mask have the same dimensions
    if image.dim() != mask.dim() {
        return Err("Image and mask dimensions must match".to_string());
    }

    // We will do adaptive thresholding with a window size of size window x window

    // Step 1: compute the average pixel value in the window
    // Extract the pixel values within the mask
    let mut masked_pixels = Vec::new();
    for (&pixel, &is_masked) in image.iter().zip(mask.iter()) {
        if is_masked {
            if inverse {
                masked_pixels.push(255 - pixel);
            } else {
                masked_pixels.push(pixel);
            }
        }
    }

    if masked_pixels.is_empty() {
        return Err("Masked pixels are empty; cannot compute Otsu threshold".to_string());
    }

    // Compute the Otsu threshold on the masked pixels
    let threshold = otsu_level(&masked_pixels);

    // Apply the threshold to the entire image to get a binary image

    let thresholded_image = if inverse {
        image.map(|&pixel| 255 - pixel > threshold)
    } else {
        image.map(|&pixel| pixel > threshold)
    };

    // Compute the logical AND between the thresholded image and the original mask
    let refined_mask = Zip::from(&thresholded_image)
        .and(mask)
        .map_collect(|&thresholded, &original_mask| thresholded && original_mask);

    Ok(refined_mask)
}

fn morpho_mask(
    mask: &Array2<bool>,
    opening: bool,
    enforce_connectedness: bool,
    kernel_size: u8,
) -> Array2<bool> {
    let mask_image = mask.map(|&v| if v { 255u8 } else { 0u8 });
    let (height, width) = mask_image.dim();
    let (raw_vec, _) = mask_image.into_raw_vec_and_offset();
    let mut morphed: GrayImage = GrayImage::from_raw(width as u32, height as u32, raw_vec).unwrap();

    if opening {
        close_mut(&mut morphed, Norm::LInf, kernel_size);
    }
    if enforce_connectedness {
        let background = Luma([0]);
        let cc = connected_components(&morphed, Connectivity::Eight, background);

        let kmers = cc.iter().copied().collect::<Vec<u32>>();
        let nodes: HashMap<u32, usize> = kmers.iter().copied().counts();
        // Find the largest connected component that is not 0
        let largest_kmer = kmers
            .iter()
            .copied()
            .filter(|&kmer| kmer != 0)
            .max_by_key(|&kmer| nodes[&kmer]);

        if let Some(largest_kmer) = largest_kmer {
            morphed = GrayImage::from_fn(cc.width(), cc.height(), |x, y| {
                if cc.get_pixel(x, y)[0] == largest_kmer && cc.get_pixel(x, y)[0] != 0 {
                    Luma([255])
                } else {
                    Luma([0])
                }
            });
        }
        //
    }

    // Convert morphed image back to Array2<bool>
    Array2::from_shape_fn(
        (morphed.height() as usize, morphed.width() as usize),
        |(y, x)| morphed.get_pixel(x as u32, y as u32)[0] > 0,
    )
}

#[tauri::command]
pub async fn otsu_segmentation(
    image: Vec<u8>,
    mask: Vec<u8>,
    opening: bool,
    inverse: bool,
    kernel_size: u8,
    connectedness: bool,
    width: usize,
    height: usize,
) -> Result<Response, String> {
    // 1. Load image and mask

    let image = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width as u32, height as u32, image).unwrap(),
    );

    let mask = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width as u32, height as u32, mask).unwrap(),
    );
    let color = mask
        .pixels()
        .collect::<Vec<_>>()
        .iter()
        .find_map(|(_, _, pixel)| {
            if pixel[3] > 0 {
                Some([pixel[0], pixel[1], pixel[2], 255])
            } else {
                None
            }
        })
        .unwrap_or([0, 0, 0, 0]);

    let image = convert_image_to_luma_u8_array(&image);
    let mask = convert_image_to_mask_array(&mask);

    let mut refined_mask = otsu_in_mask(&image, &mask, inverse)?;

    // 2. Perform morphological operation

    let morphed_mask = morpho_mask(&refined_mask, opening, connectedness, kernel_size);
    refined_mask.assign(&morphed_mask);

    // 3. Convert refined mask back to blob
    let output_mask_image: image::DynamicImage = image::DynamicImage::ImageRgba8(
        image::ImageBuffer::from_fn(width as u32, height as u32, |x, y| {
            let value = *refined_mask.get([y as usize, x as usize]).unwrap();
            if value {
                image::Rgba(color)
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        }),
    );
    Ok(Response::new(output_mask_image.to_rgba8().into_vec()))
}
