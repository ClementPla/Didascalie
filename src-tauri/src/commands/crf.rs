use image::GenericImageView;
use imageproc::distance_transform::{ self, Norm };
use tauri::ipc::Response;
use skeletonize::{ foreground, thin_image_edges, MarkingMethod };

#[tauri::command]
pub fn crf_refine(
  image: Vec<u8>,
  mask: Vec<u8>,
  width: usize,
  height: usize,
  spatial_weight: f32,
    bilateral_weight: f32,
  num_iterations: usize
) -> Result<Response, String> {
  let mask = image::DynamicImage::ImageRgba8(
    image::RgbaImage::from_raw(width as u32, height as u32, mask).unwrap()
  );
  let mut image = image::DynamicImage
    ::ImageRgb8(image::RgbImage::from_raw(width as u32, height as u32, image).unwrap())
    .to_rgba32f();

  image.pixels_mut().for_each(|pixel| {
    pixel[0] = pixel[0] / 255.0;
    pixel[1] = pixel[1] / 255.0;
    pixel[2] = pixel[2] / 255.0;
  });

  let color = mask
    .pixels()
    .collect::<Vec<_>>()
    .iter()
    .find_map(|(_, _, pixel)| {
      if pixel[0] > 0 { Some([pixel[0], pixel[1], pixel[2], pixel[3]]) } else { None }
    })
    .unwrap_or([0, 0, 0, 0]);

  let foregound_pixel = image::Rgba(color);
  let background_pixel = image::Rgba([0, 0, 0, 0]);

  let mut gray_mask = mask.to_luma8();
  // Binarise mask to thin edges

  // Threshold the mask to get a binary image
  for pixel in gray_mask.pixels_mut() {
    if pixel[0] > 0 {
      pixel[0] = 255;
    }
  }

  let mut dynamic_mask = image::DynamicImage::ImageLuma8(gray_mask);
  thin_image_edges::<foreground::White>(&mut dynamic_mask, MarkingMethod::Modified, None).unwrap();

  let mut gray_buffer = dynamic_mask.to_luma8();
  distance_transform::distance_transform_mut(&mut gray_buffer, Norm::L1);
  dynamic_mask = image::DynamicImage::ImageLuma8(gray_buffer);

  let mut maxvalue: f32 = 0.0;
  // Convert input mask to floating probability [0.0, 1.0].

  let mut q_prob: Vec<f32> = mask
    .pixels()
    .map(|p: (u32, u32, image::Rgba<u8>)| {
      let pixel = p.2;
      if pixel[0] > 0 {
        let distance = dynamic_mask.get_pixel(p.0, p.1)[0] as f32;
        maxvalue = maxvalue.max(distance);
        distance
      } else {
        0.0
      }
    })
    .collect();

  // Normalize distance transform
  for i in 0..q_prob.len() {
    q_prob[i] = f32::max(1.0 - q_prob[i] / maxvalue, 1e-7);
  }

  // Precompute unary potentials (negative log-likelihoods)
  // unary_cost[i][label] = -ln P(label) for pixel i
  // For binary labels, label = 0 or 1
  let mut unary_cost_bg: Vec<f32> = Vec::with_capacity(width * height);
  let mut unary_cost_fg: Vec<f32> = Vec::with_capacity(width * height);

  // A simple scheme: if mask[i] == 1 => cost_bg is high, cost_fg is low; vice versa
  for prob in q_prob.iter() {
    unary_cost_fg.push(-prob.ln());
    unary_cost_bg.push(-(1.0 - prob).ln());
  }

  // Time the CRF refinement

  let start = std::time::Instant::now();

  // Mean-field updates
  for _iter in 0..num_iterations {
    // Step 1: Compute pairwise message for each pixel
    // For simplicity, we'll do a small neighborhood (4 neighbors) and a color-based factor.
    // In practice, you’d do efficient filtering (e.g., permutohedral lattice).
    let mut message_fg = vec![0.0f32; width * height];
    let mut message_bg = vec![0.0f32; width * height];

    for y in 0..height {
      for x in 0..width {
        if mask.get_pixel(x as u32, y as u32)[0] == 0 {
          continue;
        }
        let i = y * width + x;
        let pixel = image.get_pixel(x as u32, y as u32);
        let r = pixel[0];
        let g = pixel[1];
        let b = pixel[2];

        // Gather neighbors
        let neighbors = neighbor_coords(x, y, width, height);
        for &(nx, ny) in &neighbors {
          if mask.get_pixel(nx as u32, ny as u32)[0] == 0 {
            continue;
          }
          let j = ny * width + nx;
          let npixel = image.get_pixel(nx as u32, ny as u32);
          let nr = npixel[0];
          let ng = npixel[1];
          let nb = npixel[2];

          // Color distance
          let color_dist_sq = (r - nr).powi(2) + (g - ng).powi(2) + (b - nb).powi(2);

          // Pairwise term — smaller if colors are similar
          let color_similarity = (-color_dist_sq / 2.0).exp();

          let spatial_dist_sq = (((x as i32) - (nx as i32)).pow(2) +
            ((y as i32) - (ny as i32)).pow(2)) as f32;
          let spatial_similarity = (-spatial_dist_sq / 2.0).exp();
          let pairwise_factor =
            spatial_weight * spatial_similarity + bilateral_weight * color_similarity;

          // Accumulate message
          // We treat q_prob[j] as the neighbor's probability of being FG
          message_fg[i] += q_prob[j] * pairwise_factor;
          message_bg[i] += (1.0 - q_prob[j]) * pairwise_factor;
        }
      }
    }

    // Step 2: Integrate unary and pairwise into new Q
    for y in 0..height {
      for x in 0..width {
        if mask.get_pixel(x as u32, y as u32)[0] == 0 {
          continue;
        }
        let i = y * width + x;
        // Negative log-likelihood from unary
        let cost_fg = unary_cost_fg[i];
        let cost_bg = unary_cost_bg[i];

        // Pairwise cost: we interpret message_fg/bg as negative log-likelihood increments
        // In practice, one might transform them or treat them differently,
        // but here's a simplistic interpretation:
        let pairwise_cost_fg = -message_fg[i];
        let pairwise_cost_bg = -message_bg[i];

        // Combined cost
        let total_cost_fg = cost_fg + pairwise_cost_fg;
        let total_cost_bg = cost_bg + pairwise_cost_bg;

        // Convert costs into normalized probabilities:
        // prob = exp(-cost), then normalize
        let exp_fg = (-total_cost_fg).exp();
        let exp_bg = (-total_cost_bg).exp();
        let sum = exp_fg + exp_bg;

        q_prob[i] = exp_fg / sum;
      }
    }
  }

  println!("CRF refinement took: {:?}", start.elapsed());

  // 3. Convert refined mask back to blob
  let output_mask_image: image::DynamicImage = image::DynamicImage::ImageRgba8(
    image::ImageBuffer::from_fn(width as u32, height as u32, |x, y| {
      if mask.get_pixel(x, y)[0] == 0 {
        return background_pixel;
      }
      let proba = q_prob[(y as usize) * (width as usize) + (x as usize)];
      if proba > 0.5 {
        foregound_pixel
      } else {
        background_pixel
      }
    })
  );

  Ok(Response::new(output_mask_image.to_rgba8().into_vec()))
}

/// Returns the 4-neighbors (up, down, left, right) of (x, y) if they exist.
fn neighbor_coords(x: usize, y: usize, width: usize, height: usize) -> Vec<(usize, usize)> {
  let mut neighbors = Vec::new();
  for i in -3..3 {
    for j in -3..3 {
      if i == 0 && j == 0 {
        continue;
      }
      if (x as i32) + i < 0 || (x as i32) + i >= (width as i32) {
        continue;
      }
      if (y as i32) + j < 0 || (y as i32) + j >= (height as i32) {
        continue;
      }
      neighbors.push((((x as i32) + i) as usize, ((y as i32) + j) as usize));
    }
  }
  neighbors
}
