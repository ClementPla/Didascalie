use super::images::{convert_image_to_luma_u8_array, convert_image_to_mask_array};
use super::refine::{denoise, denoise_f32, presence_bytes, refine, Refine};
use crate::pixels::picture::effective_settings;
use crate::pixels::cache::RawFrameCache;
use crate::pixels::display::Region;
use crate::pixels::intensity::{intensity_region, Source};
use crate::storage::DbState;
use ndarray::{Array2, Zip};
use tauri::{self, ipc::Response, State};

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

#[tauri::command]
pub async fn otsu_segmentation(
    image: Vec<u8>,
    mask: Vec<u8>,
    inverse: bool,
    denoise_sigma: f32,
    smooth: f32,
    fill_holes: bool,
    connectedness: bool,
    width: usize,
    height: usize,
) -> crate::utils::error::Result<Response> {
    let (width, height) = (
        u32::try_from(width).map_err(|_| "Image width out of range")?,
        u32::try_from(height).map_err(|_| "Image height out of range")?,
    );
    let image = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width, height, image)
            .ok_or("The image buffer does not match its dimensions")?,
    );
    let mask = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width, height, mask)
            .ok_or("The stroke mask does not match the image")?,
    );

    // Thresholding a lightly blurred image gives an outline free of pixel
    // noise that still follows the real edge.
    let image = denoise(&convert_image_to_luma_u8_array(&image), denoise_sigma);
    let mask = convert_image_to_mask_array(&mask);

    let refined_mask = refine(
        &otsu_in_mask(&image, &mask, inverse)?,
        &Refine { fill_holes, smooth, largest_only: connectedness },
    );

    Ok(Response::new(presence_bytes(&refined_mask)))
}

/// Bins of the float Otsu histogram: finer than the 256 levels of 8-bit data.
const UNIT_BINS: usize = 4096;

/// Otsu threshold of intensities in 0–1.
fn otsu_level_unit(values: &[f32]) -> f32 {
    let mut histogram = vec![0u64; UNIT_BINS];
    for &v in values {
        let b = (v.clamp(0.0, 1.0) * (UNIT_BINS - 1) as f32).round() as usize;
        histogram[b] += 1;
    }
    let total = values.len() as f64;
    let total_mean: f64 = histogram.iter().enumerate().map(|(i, &c)| i as f64 * c as f64).sum::<f64>() / total;
    let (mut w0, mut sum0) = (0.0f64, 0.0f64);
    let (mut best, mut threshold) = (0.0f64, 0usize);
    for (t, &c) in histogram.iter().enumerate() {
        let p = c as f64 / total;
        w0 += p;
        if w0 == 0.0 {
            continue;
        }
        let w1 = 1.0 - w0;
        if w1 <= 0.0 {
            break;
        }
        sum0 += t as f64 * p;
        let (m0, m1) = (sum0 / w0, (total_mean - sum0) / w1);
        let between = w0 * w1 * (m0 - m1) * (m0 - m1);
        if between > best {
            best = between;
            threshold = t;
        }
    }
    // The upper edge of the threshold bin: its values belong to the dark class.
    (threshold as f32 + 0.5) / (UNIT_BINS - 1) as f32
}

/// The pixels under `mask` brighter (with `inverse`, darker) than their Otsu
/// threshold.
fn otsu_in_mask_unit(image: &Array2<f32>, mask: &Array2<bool>, inverse: bool) -> Result<Array2<bool>, String> {
    if image.dim() != mask.dim() {
        return Err("Image and mask dimensions must match".to_string());
    }
    let flip = |v: f32| if inverse { 1.0 - v } else { v };
    let masked: Vec<f32> = image.iter().zip(mask.iter()).filter(|(_, m)| **m).map(|(v, _)| flip(*v)).collect();
    if masked.is_empty() {
        return Err("Masked pixels are empty; cannot compute Otsu threshold".to_string());
    }
    let threshold = otsu_level_unit(&masked);
    Ok(Zip::from(image).and(mask).map_collect(|&v, &m| m && flip(v) > threshold))
}

/// [`otsu_segmentation`] on raw pixels: the intensity (0–1, the display window
/// applied) of the frame's region under the stroke, read from the raw cache
/// instead of the 8-bit canvas. `mask` is the stroke region as RGBA.
#[tauri::command]
pub async fn otsu_segmentation_raw(
    db: State<'_, DbState>,
    cache: State<'_, RawFrameCache>,
    frame_id: i64,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    mask: Vec<u8>,
    source: Option<u32>,
    inverse: bool,
    denoise_sigma: f32,
    smooth: f32,
    fill_holes: bool,
    connectedness: bool,
) -> crate::utils::error::Result<Response> {
    let mask = image::RgbaImage::from_raw(width, height, mask)
        .ok_or("The stroke mask does not match the region")?;
    let mask = convert_image_to_mask_array(&image::DynamicImage::ImageRgba8(mask));

    let d = cache.get(&db, frame_id)?;
    let settings = effective_settings(&db, &d, frame_id)?;
    let region = Region { x, y, width, height }.bounded(d.frame.width, d.frame.height)?;
    let intensity = intensity_region(&d.frame, &settings, region, Source::from_option(source));
    let intensity = denoise_f32(&intensity, denoise_sigma);

    let refined = refine(
        &otsu_in_mask_unit(&intensity, &mask, inverse)?,
        &Refine { fill_holes, smooth, largest_only: connectedness },
    );
    Ok(Response::new(presence_bytes(&refined)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_otsu_splits_two_close_populations_8_bits_would_merge() {
        // Dim cells at 0.5000 and background at 0.4990: one 8-bit level apart
        // at most, but separate in the float histogram.
        let mut values = vec![0.499f32; 100];
        values.extend(std::iter::repeat_n(0.5f32, 100));
        let t = otsu_level_unit(&values);
        assert!((0.499..0.5).contains(&t), "threshold {t}");
    }

    #[test]
    fn unit_otsu_in_mask_keeps_the_bright_side_or_the_dark_one() {
        let image = Array2::from_shape_vec((1, 4), vec![0.1, 0.9, 0.85, 0.2]).unwrap();
        let mask = Array2::from_shape_vec((1, 4), vec![true, true, true, false]).unwrap();
        let bright = otsu_in_mask_unit(&image, &mask, false).unwrap();
        assert_eq!(bright.as_slice().unwrap(), &[false, true, true, false]);
        let dark = otsu_in_mask_unit(&image, &mask, true).unwrap();
        assert_eq!(dark.as_slice().unwrap(), &[true, false, false, false]);
    }
}
