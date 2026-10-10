use super::images::{convert_image_to_luma_u8_array, convert_image_to_mask_array};
use image::{GrayImage, Luma};
use imageproc::region_labelling::{connected_components, Connectivity};
use itertools::Itertools;
use ndarray::{Array2, Zip};
use std::collections::HashMap;
use tauri::{self, ipc::Response}; // for .into_par_iter()

fn otsu_level(pixels: &Vec<u8>) -> u8 {
    let mut histogram = [0u32; 256];
    for &pixel in pixels {
        histogram[pixel as usize] += 1;
    }

    let total_pixels = pixels.len() as f64;

    let mut probability = [0f64; 256];
    for i in 0..256 {
        probability[i] = (histogram[i] as f64) / total_pixels;
    }

    let mut max_between_class_variance = 0.0;
    let mut optimal_threshold = 0u8;

    let mut w0 = 0.0; // Weight for background class
    let mut sum0 = 0.0; // Cumulative sum for background class
    let mut total_mean = 0.0;

    for i in 0..256 {
        total_mean += (i as f64) * probability[i];
    }

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

        let between_class_variance = w0 * w1 * (μ0 - μ1) * (μ0 - μ1);

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
    if image.dim() != mask.dim() {
        return Err("Image and mask dimensions must match".to_string());
    }

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

    // Otsu threshold of the pixels under the mask.
    let threshold = otsu_level(&masked_pixels);

    let thresholded_image = if inverse {
        image.map(|&pixel| 255 - pixel > threshold)
    } else {
        image.map(|&pixel| pixel > threshold)
    };

    let refined_mask = Zip::from(&thresholded_image)
        .and(mask)
        .map_collect(|&thresholded, &original_mask| thresholded && original_mask);

    Ok(refined_mask)
}

fn dilation(mask: &Array2<bool>, kernel_size: u8) -> Array2<bool> {
    let (height, width) = mask.dim();
    let mut result = Array2::from_elem((height, width), false);

    let radius = kernel_size as i32 / 2;

    let mut disk_offsets = Vec::new();
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if (dx * dx + dy * dy) <= (radius * radius) {
                disk_offsets.push((dx, dy));
            }
        }
    }

    for y in 0..height {
        for x in 0..width {
            let mut any_foreground = false;

            for &(dx, dy) in &disk_offsets {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;

                if nx >= 0 && nx < width as i32 && ny >= 0 && ny < height as i32 {
                    if mask[[ny as usize, nx as usize]] {
                        any_foreground = true;
                        break;
                    }
                }
            }

            result[[y, x]] = any_foreground;
        }
    }

    result
}

fn erosion(mask: &Array2<bool>, kernel_size: u8) -> Array2<bool> {
    let (height, width) = mask.dim();
    let mut result = Array2::from_elem((height, width), false);

    let radius = kernel_size as i32 / 2;

    let mut disk_offsets = Vec::new();
    for dy in -radius..=radius {
        for dx in -radius..=radius {
            if (dx * dx + dy * dy) <= (radius * radius) {
                disk_offsets.push((dx, dy));
            }
        }
    }

    for y in 0..height {
        for x in 0..width {
            let mut all_foreground = true;

            for &(dx, dy) in &disk_offsets {
                let nx = x as i32 + dx;
                let ny = y as i32 + dy;

                if nx < 0 || nx >= width as i32 || ny < 0 || ny >= height as i32 {
                    all_foreground = false;
                    break;
                }

                if !mask[[ny as usize, nx as usize]] {
                    all_foreground = false;
                    break;
                }
            }

            result[[y, x]] = all_foreground;
        }
    }

    result
}

/// Clean up a binary selection: optional morphological closing and optional
/// largest-connected-component filter. Shared by Otsu and flood fill.
pub(crate) fn morpho_mask(
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
        let dilated = dilation(mask, 2 * kernel_size);
        let closed = erosion(&dilated, 2 * kernel_size);
        morphed = GrayImage::from_fn(width as u32, height as u32, |x, y| {
            if closed[[y as usize, x as usize]] {
                Luma([255])
            } else {
                Luma([0])
            }
        });
    }
    if enforce_connectedness {
        let background = Luma([0]);
        let cc = connected_components(&morphed, Connectivity::Eight, background);

        let kmers = cc.iter().copied().collect::<Vec<u32>>();
        let nodes: HashMap<u32, usize> = kmers.iter().copied().counts();
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
    }

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

    let image = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width as u32, height as u32, image).unwrap(),
    );

    let mask = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width as u32, height as u32, mask).unwrap(),
    );

    let image = convert_image_to_luma_u8_array(&image);
    let mask = convert_image_to_mask_array(&mask);

    let mut refined_mask = otsu_in_mask(&image, &mask, inverse)?;

    let morphed_mask = morpho_mask(&refined_mask, opening, connectedness, kernel_size);
    refined_mask.assign(&morphed_mask);

    // Single-channel presence mask (255 = foreground), row-major.
    let mut output = vec![0u8; width * height];
    for y in 0..height {
        for x in 0..width {
            if *refined_mask.get([y, x]).unwrap() {
                output[y * width + x] = 255;
            }
        }
    }
    Ok(Response::new(output))
}
