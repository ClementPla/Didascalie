use super::images::{
    convert_image_to_luma_u8_array, convert_image_to_mask_array, convert_image_to_rgb_u8_array,
    convert_rgb_to_blob, load_blob_to_image,
};
use crate::tools;
use image::{GenericImageView, GrayImage, ImageBuffer, Luma};
use imageproc::distance_transform::Norm;
use imageproc::morphology::{close, dilate, erode, open};
use imageproc::region_labelling::{connected_components, Connectivity};
use itertools::Itertools;
use ndarray::{s, Array2, Array3, Zip};
use rayon::prelude::*;
use std::collections::HashSet;
use std::collections::{HashMap, VecDeque};
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
        morphed = open(&morphed, Norm::L1, kernel_size);
        morphed = close(&morphed, Norm::L1, kernel_size);
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
            if pixel[0] > 0 {
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

#[tauri::command]
pub async fn find_overlapping_region(
    label: Vec<u8>,
    mask: Vec<u8>,
    width: usize,
    height: usize,
) -> Result<Response, String> {
    // 1. Load label and mask
    let label = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width as u32, height as u32, label).unwrap(),
    )
    .to_luma8();

    let mask = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width as u32, height as u32, mask).unwrap(),
    );

    // 2. Find connected components in the label image
    let connected_components = connected_components(&label, Connectivity::Eight, Luma([0]));

    // --- First pass: Collect IDs of components that overlap with `mask` ---
    // Use a HashSet for O(1) membership lookup
    let connected_components = std::sync::Arc::new(connected_components);
    let mask = std::sync::Arc::new(mask);
    let overlap_labels = (0..height as u32)
        .into_par_iter()
        .map(|y| {
            let mut local_labels = HashSet::new();

            for x in 0..width as u32 {
                let label_value = connected_components.get_pixel(x, y)[0];
                let mask_val = mask.get_pixel(x, y)[0];
                if label_value != 0 && mask_val != 0 {
                    local_labels.insert(label_value);
                }
            }

            // Return partial HashSet and partial bounding box
            local_labels
        })
        .reduce(
            // Identity
            || HashSet::new(),
            // Reduction
            |mut set_a, set_b| {
                // Combine the sets
                set_a.extend(set_b);

                // Combine bounding boxes

                set_a
            },
        );

    // Now we have a global `overlap_labels` HashSet and a combined bounding box.
    let overlap_labels = overlap_labels; // HashSet<u32>
                                         // --- Second pass: For every pixel, check if its connected-component ID is in `overlap_labels` ---
                                         // Create a 2D array of bool to store the final overlap.
                                         // Create one big array of false
    let mut overlapping_region = Array2::from_elem((height, width), false);

    // We can safely split by rows and update without data races,
    // because each row is independent:
    overlapping_region
        .axis_chunks_iter_mut(ndarray::Axis(0), 1) // each row = axis 0
        .into_par_iter() // parallelize over rows
        .enumerate() // get the row index
        .for_each(|(y, mut row)| {
            // For each x in this row
            for (x, elem) in row.iter_mut().enumerate() {
                let label_value = connected_components.get_pixel(x as u32, y as u32)[0];
                if overlap_labels.contains(&label_value) {
                    *elem = true;
                }
            }
        });

    // 3. Convert refined mask back to blob
    let output_mask_image: image::DynamicImage = image::DynamicImage::ImageRgba8(
        image::ImageBuffer::from_fn(width as u32, height as u32, |x, y| {
            if overlapping_region[[y as usize, x as usize]] {
                image::Rgba([255, 255, 255, 255])
            } else {
                image::Rgba([0, 0, 0, 0])
            }
        }),
    );

    Ok(Response::new(output_mask_image.to_rgba8().into_vec()))
}

#[tauri::command]
pub async fn get_overlapping_region_with_mask(
    label: Vec<bool>,
    mask: Vec<bool>,
    width: usize,
    height: usize,
) -> Result<Response, String> {
    // 1) Combine label + mask in one pass, track first non-zero pixel
    //    Note: We'll only store a single-channel "combined_mask"
    //    (0 => no overlap, 255 => overlap).
    let mut combined_mask = vec![false; width * height];
    let mut first_nonzero_index = None;

    for i in 0..(width * height) {
        let label_r = label[i]; // 'R' channel if RGBA
        let mask_r = mask[i];
        if mask_r {
            if first_nonzero_index.is_none() {
                first_nonzero_index = Some(i);
            }
        }
        if label_r || mask_r {
            combined_mask[i] = true;
        }
    }

    // If there's no overlap at all, short-circuit with an empty/zero output
    let Some(first_idx) = first_nonzero_index else {
        // Return all-zero RGBA
        return Ok(Response::new(vec![0u8; width * height * 4]));
    };

    // Convert that linear index into (x, y)
    let first_x = first_idx % width;
    let first_y = first_idx / width;

    // 2) Flood fill (BFS) from (first_x, first_y) to find the connected region
    let mut visited = vec![false; width * height];
    visited[first_idx] = true;

    let mut queue = VecDeque::new();
    queue.push_back((first_x, first_y));

    // We'll collect all the (x, y) pixels that are in the same connected region
    // as the first non-zero overlap we found.
    let mut region_pixels = Vec::new();

    while let Some((x, y)) = queue.pop_front() {
        region_pixels.push((x, y));

        for (nx, ny) in neighbors_8(x, y, width, height) {
            let n_idx = ny * width + nx;
            if !visited[n_idx] && combined_mask[n_idx] {
                visited[n_idx] = true;
                queue.push_back((nx, ny));
            }
        }
    }
    println!("Found {} connected pixels", region_pixels.len());

    // 3) Prepare the final RGBA output, marking the connected region in white
    let mut output = vec![0_u8; width * height];
    for (x, y) in region_pixels {
        let i: usize = y * width + x;
        output[i] = 255; // A
    }

    Ok(Response::new(output))
}

fn neighbors_8(
    x: usize,
    y: usize,
    width: usize,
    height: usize,
) -> impl Iterator<Item = (usize, usize)> {
    // Offsets for up, right, down, left
    const OFFSETS: [(isize, isize); 8] = [
        (-1, -1),
        (0, -1),
        (1, -1),
        (-1, 0),
        (1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
    ];

    OFFSETS.into_iter().filter_map(move |(dx, dy)| {
        let nx = x as isize + dx;
        let ny = y as isize + dy;
        if nx >= 0 && (nx as usize) < width && ny >= 0 && (ny as usize) < height {
            Some((nx as usize, ny as usize))
        } else {
            None
        }
    })
}

#[tauri::command]
pub async fn edge_detection(mask: Vec<u8>) -> Result<Response, String> {
    // 1. Load mask
    let mask = load_blob_to_image(&mask)?;

    let h = mask.height() as usize;
    let w = mask.width() as usize;

    let mask = convert_image_to_rgb_u8_array(&mask);

    // 2. Perform edge detection
    // For each channel, compute imageproc::morphology::grayscale_dilate - imageproc::morphology::grayscale_erode

    let mut edge_mask = Array3::from_elem(mask.dim(), 0u8);

    // Vec that store each channel

    for i in 0..3 {
        // Extract channel as GrayImage

        let channel = mask.slice(s![.., .., i]).to_owned().map(|&v| v);

        let channel =
            GrayImage::from_raw(w as u32, h as u32, channel.into_raw_vec_and_offset().0).unwrap();

        let dilated: ImageBuffer<Luma<u8>, Vec<u8>> = dilate(&channel, Norm::L1, 3);
        let eroded = erode(&channel, Norm::L1, 3);

        let diff = ImageBuffer::from_fn(dilated.width(), dilated.height(), |x, y| {
            let dilated_pixel = dilated.get_pixel(x, y)[0];
            let eroded_pixel = eroded.get_pixel(x, y)[0];
            Luma([dilated_pixel.saturating_sub(eroded_pixel)])
        });

        let diff_array =
            Array2::from_shape_fn((diff.height() as usize, diff.width() as usize), |(y, x)| {
                diff.get_pixel(x as u32, y as u32)[0]
            });
        edge_mask.slice_mut(s![.., .., i]).assign(&diff_array);
    }

    // 3. Convert edge mask back to blob

    let output_blob = convert_rgb_to_blob(&edge_mask.view())?;

    Ok(Response::new(output_blob))
}

#[tauri::command]
pub fn get_quad_tree_bbox(
    mask: Vec<u8>,
    width: usize,
    height: usize,
    new_width: usize,
    new_height: usize,
    max_depth: u32,
    min_size: u32,
) -> Result<Response, String> {
    let mask: image::DynamicImage = image::DynamicImage::ImageRgba8(
        image::RgbaImage::from_raw(width as u32, height as u32, mask).unwrap(),
    );
    let mask: image::DynamicImage = mask.resize_exact(
        new_width as u32,
        new_height as u32,
        image::imageops::FilterType::Nearest,
    );

    let gray = mask.to_luma8();

    let bbox = tools::split_and_merge::quadtree_bounding_boxes(&gray, max_depth, min_size);

    // Serialize the bounding boxes to JSON string
    let bbox_json = serde_json::to_string(&bbox).map_err(|e| e.to_string())?;

    // Return the bounding boxes as JSON string
    Ok(Response::new(bbox_json))
}
