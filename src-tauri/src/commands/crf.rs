use tauri::ipc::Response;

#[tauri::command]
pub fn crf_refine(
    image: Vec<u8>,
    mask: Vec<u8>,
    width: usize,
    height: usize,
    spatial_weight: f32,
    bilateral_weight: f32,
    num_iterations: usize,
) -> Result<Response, String> {
    let mask_img = image::RgbaImage::from_raw(width as u32, height as u32, mask)
        .ok_or("Invalid mask dimensions")?;

    let image_rgba = image::RgbaImage::from_raw(width as u32, height as u32, image)
        .ok_or("Invalid image dimensions")?;

    // Create binary mask based on ALPHA channel
    let mut gray_mask = image::GrayImage::new(width as u32, height as u32);
    for y in 0..height {
        for x in 0..width {
            let pixel = mask_img.get_pixel(x as u32, y as u32);
            gray_mask.put_pixel(
                x as u32,
                y as u32,
                image::Luma([if pixel[3] > 128 { 255 } else { 0 }]),
            );
        }
    }

    let has_foreground = gray_mask.pixels().any(|p| p[0] > 0);
    if !has_foreground {
        return Err("Mask is empty - no foreground pixels found".to_string());
    }

    println!("Starting edge-aware refinement...");

    // Identify edge pixels (foreground pixels adjacent to background)
    let mut is_edge_pixel: Vec<bool> = vec![false; width * height];
    for y in 0..height {
        for x in 0..width {
            if gray_mask.get_pixel(x as u32, y as u32)[0] == 0 {
                continue; // Skip background
            }

            // Check if any neighbor is background
            let mut has_bg_neighbor = false;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < width as i32 && ny >= 0 && ny < height as i32 {
                        if gray_mask.get_pixel(nx as u32, ny as u32)[0] == 0 {
                            has_bg_neighbor = true;
                            break;
                        }
                    }
                }
                if has_bg_neighbor {
                    break;
                }
            }
            is_edge_pixel[y * width + x] = has_bg_neighbor;
        }
    }

    let edge_count = is_edge_pixel.iter().filter(|&&e| e).count();
    println!("Edge pixels to refine: {}", edge_count);

    // Initialize probabilities: 1.0 for interior, variable for edges
    let mut q_prob: Vec<f32> = (0..width * height)
        .map(|i| {
            let x = i % width;
            let y = i / width;
            let mask_val = gray_mask.get_pixel(x as u32, y as u32)[0];

            if mask_val == 0 {
                0.0 // Background
            } else if is_edge_pixel[i] {
                0.5 // Edge pixels start uncertain
            } else {
                1.0 // Interior pixels stay
            }
        })
        .collect();

    let start = std::time::Instant::now();

    // Refine only edge pixels based on color affinity
    for iter in 0..num_iterations {
        let mut new_q_prob = q_prob.clone();
        let mut total_change = 0.0f32;
        let mut num_refined = 0;

        for y in 0..height {
            for x in 0..width {
                let i = y * width + x;

                // Only refine edge pixels
                if !is_edge_pixel[i] {
                    continue;
                }

                num_refined += 1;

                let pixel = image_rgba.get_pixel(x as u32, y as u32);
                let r = pixel[0] as f32;
                let g = pixel[1] as f32;
                let b = pixel[2] as f32;

                // Compute color affinity to foreground vs background neighbors
                let mut fg_affinity = 0.0f32;
                let mut bg_affinity = 0.0f32;
                let mut fg_count = 0;
                let mut bg_count = 0;

                // Check neighbors in a larger radius
                for dy in -3i32..=3 {
                    for dx in -3i32..=3 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let nx = x as i32 + dx;
                        let ny = y as i32 + dy;

                        if nx < 0 || nx >= width as i32 || ny < 0 || ny >= height as i32 {
                            continue;
                        }

                        let npixel = image_rgba.get_pixel(nx as u32, ny as u32);
                        let nr = npixel[0] as f32;
                        let ng = npixel[1] as f32;
                        let nb = npixel[2] as f32;

                        // Color distance
                        let color_dist =
                            ((r - nr).powi(2) + (g - ng).powi(2) + (b - nb).powi(2)).sqrt();

                        // Spatial distance
                        let spatial_dist = ((dx * dx + dy * dy) as f32).sqrt();

                        // Weight: closer and more similar = higher weight
                        let weight = (-color_dist / bilateral_weight).exp()
                            * (-spatial_dist / spatial_weight).exp();

                        let is_fg = gray_mask.get_pixel(nx as u32, ny as u32)[0] > 0;

                        if is_fg && !is_edge_pixel[ny as usize * width + nx as usize] {
                            // Interior foreground neighbor
                            fg_affinity += weight;
                            fg_count += 1;
                        } else if !is_fg {
                            // Background neighbor
                            bg_affinity += weight;
                            bg_count += 1;
                        }
                    }
                }

                // Normalize by count
                if fg_count > 0 {
                    fg_affinity /= fg_count as f32;
                }
                if bg_count > 0 {
                    bg_affinity /= bg_count as f32;
                }

                // Compute probability based on relative affinity
                let total_affinity = fg_affinity + bg_affinity;
                let new_prob = if total_affinity > 0.0 {
                    (fg_affinity / total_affinity).clamp(0.0, 1.0)
                } else {
                    q_prob[i] // Keep old value if no info
                };

                total_change += (new_prob - q_prob[i]).abs();
                new_q_prob[i] = new_prob;
            }
        }

        q_prob = new_q_prob;
        let avg_change = if num_refined > 0 {
            total_change / num_refined as f32
        } else {
            0.0
        };

        if iter % 5 == 0 || iter == num_iterations - 1 {
            let fg_pixels = q_prob.iter().filter(|&&p| p > 0.5).count();
            println!(
                "Iteration {}: avg change = {:.6}, FG pixels (>0.5): {}",
                iter, avg_change, fg_pixels
            );
        }

        if avg_change < 0.001 {
            println!("Converged at iteration {}", iter);
            break;
        }
    }

    println!("Edge refinement took: {:?}", start.elapsed());

    let output_mask_image = image::ImageBuffer::from_fn(width as u32, height as u32, |x, y| {
        let prob = q_prob[(y as usize) * width + (x as usize)];
        if prob > 0.5 {
            let mask_pixel = mask_img.get_pixel(x, y);
            image::Rgba([mask_pixel[0], mask_pixel[1], mask_pixel[2], 255])
        } else {
            image::Rgba([0, 0, 0, 0])
        }
    });

    Ok(Response::new(output_mask_image.into_vec()))
}
