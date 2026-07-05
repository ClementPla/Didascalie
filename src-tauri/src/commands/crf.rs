use rayon::prelude::*;
use tauri::ipc::Response;

/// Reference colors per model are subsampled to this many to keep the
/// nearest-neighbor color lookup cheap.
const MAX_SAMPLES: usize = 48;

/// Refine a coarse brush stroke into a segmentation with a mean-field dense CRF
/// over a foreground / background labeling of the region.
///
/// The key to making a *scribble* usable (rather than just smoothing it) is an
/// appearance-based unary, GrabCut-style:
///   * a **foreground color model** is sampled from the painted stroke;
///   * a **background color model** is sampled from an outer border band of the
///     region, which is assumed to be background;
///   * every pixel's unary is driven by which model its color is closer to, so
///     unpainted pixels that match the object's color are pulled into the mask
///     (the mask fills the object) and painted spill-over onto background color
///     is pulled out.
///
/// A `stroke_bias` keeps painted pixels anchored to foreground, and `growth`
/// shifts the FG/BG decision boundary (positive grows, negative trims).
///
/// The pairwise terms then enforce spatial coherence:
///   * a **bilateral** term (position + color) that snaps the boundary onto
///     color edges, using a spatial normalizer with color as a gate so it never
///     degenerates into an eroding neighborhood average;
///   * a **smoothness** term (position only) that removes speckle.
///
/// Returns a white / transparent RGBA mask (the caller colorizes it), matching
/// the flood-fill / superpixel output convention.
#[tauri::command]
pub fn crf_refine(
    image: Vec<u8>,
    mask: Vec<u8>,
    width: usize,
    height: usize,
    color_scale: f32,
    growth: f32,
    stroke_bias: f32,
    edge_weight: f32,
    edge_spatial: f32,
    edge_color: f32,
    smoothness_weight: f32,
    num_iterations: usize,
) -> Result<Response, String> {
    let n = width * height;
    if n == 0 || image.len() < n * 4 || mask.len() < n * 4 {
        return Err("Image/mask buffer smaller than width*height*4".to_string());
    }

    // Coarse foreground from the mask alpha channel.
    let seed_fg: Vec<bool> = (0..n).map(|i| mask[i * 4 + 3] > 128).collect();
    let has_fg = seed_fg.iter().any(|&f| f);
    let has_bg = seed_fg.iter().any(|&f| !f);
    // Nothing to refine (region is entirely painted or entirely empty).
    if !has_fg || !has_bg {
        return Ok(Response::new(labels_to_mask(&seed_fg)));
    }

    // Per-pixel RGB as f32 for cache-friendly neighbor reads.
    let rgb: Vec<[f32; 3]> = (0..n)
        .map(|i| {
            [
                image[i * 4] as f32,
                image[i * 4 + 1] as f32,
                image[i * 4 + 2] as f32,
            ]
        })
        .collect();

    // Foreground samples from the stroke; background samples from an outer
    // border band assumed to be background (skipping any painted pixels there).
    let bw = (width.min(height) / 6).clamp(2, 12);
    let mut fg_idx = Vec::new();
    let mut bg_idx = Vec::new();
    for i in 0..n {
        let x = i % width;
        let y = i / width;
        let on_border = x < bw || x >= width - bw || y < bw || y >= height - bw;
        if seed_fg[i] {
            fg_idx.push(i);
        } else if on_border {
            bg_idx.push(i);
        }
    }
    let fg_samples = subsample(&rgb, &fg_idx, MAX_SAMPLES);
    let bg_samples = subsample(&rgb, &bg_idx, MAX_SAMPLES);

    let color_scale = color_scale.max(1.0);
    let edge_spatial = edge_spatial.max(0.5);
    let edge_color = edge_color.max(1.0);
    let smoothness_spatial = 3.0f32;
    let iterations = num_iterations.max(1);

    // Pairwise windows ~ 2.5σ, clamped so the cost stays bounded.
    let rad_b = ((edge_spatial * 2.5).ceil() as i32).clamp(1, 16);
    let rad_s = ((smoothness_spatial * 2.5).ceil() as i32).clamp(1, 10);
    let inv2_pos = 1.0 / (2.0 * edge_spatial * edge_spatial);
    let inv2_col = 1.0 / (2.0 * edge_color * edge_color);
    let inv2_smo = 1.0 / (2.0 * smoothness_spatial * smoothness_spatial);

    // Appearance unary (log-odds). >0 favors foreground. When no background
    // samples are available (e.g. the region is mostly painted), fall back to a
    // fixed "far" background distance so the color model still segments by
    // similarity to the stroke.
    const BG_FALLBACK: f32 = 60.0;
    const CLAMP: f32 = 6.0;
    let unary: Vec<f32> = (0..n)
        .into_par_iter()
        .map(|i| {
            let c = rgb[i];
            let d_fg = min_dist(&fg_samples, c);
            let d_bg = if bg_samples.is_empty() {
                BG_FALLBACK
            } else {
                min_dist(&bg_samples, c)
            };
            let u = ((d_bg - d_fg) / color_scale + growth).clamp(-CLAMP, CLAMP);
            if seed_fg[i] {
                u + stroke_bias
            } else {
                u
            }
        })
        .collect();

    // Q(FG) initialized from the unary.
    let mut q: Vec<f32> = unary.iter().map(|&u| sigmoid(u)).collect();

    let start = std::time::Instant::now();
    let w = width as i32;
    let h = height as i32;

    for _ in 0..iterations {
        // Each pixel reads its neighbors' Q from the previous iteration (q) and
        // writes into q_new — no aliasing, safe to parallelize.
        let q_new: Vec<f32> = (0..n)
            .into_par_iter()
            .map(|i| {
                let x = (i % width) as i32;
                let y = (i / width) as i32;
                let ci = rgb[i];

                // Neighbors cast a vote in [-1, 1] (BG..FG). The bilateral term
                // weights by color similarity but normalizes by the *spatial*
                // weight only, so differently-colored neighbors fade to a zero
                // vote instead of eroding the estimate toward the local average.
                let mut b_num = 0.0f32;
                let mut b_z = 0.0f32;
                let mut s_num = 0.0f32;
                let mut s_z = 0.0f32;

                let y0 = (y - rad_b).max(0);
                let y1 = (y + rad_b).min(h - 1);
                let x0 = (x - rad_b).max(0);
                let x1 = (x + rad_b).min(w - 1);

                for ny in y0..=y1 {
                    let dy = ny - y;
                    let row = (ny as usize) * width;
                    for nx in x0..=x1 {
                        let dx = nx - x;
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let j = row + nx as usize;
                        let vote = 2.0 * q[j] - 1.0;
                        let d2 = (dx * dx + dy * dy) as f32;

                        let cj = rgb[j];
                        let dc2 = (ci[0] - cj[0]).powi(2)
                            + (ci[1] - cj[1]).powi(2)
                            + (ci[2] - cj[2]).powi(2);
                        let w_pos = (-d2 * inv2_pos).exp();
                        let w_col = (-dc2 * inv2_col).exp();
                        b_num += w_pos * w_col * vote;
                        b_z += w_pos;

                        if dx.abs() <= rad_s && dy.abs() <= rad_s {
                            let w_sm = (-d2 * inv2_smo).exp();
                            s_num += w_sm * vote;
                            s_z += w_sm;
                        }
                    }
                }

                let b_signed = if b_z > 0.0 { b_num / b_z } else { 0.0 };
                let s_signed = if s_z > 0.0 { s_num / s_z } else { 0.0 };

                // Mean-field update: appearance unary + coherent pairwise terms.
                let logit =
                    unary[i] + edge_weight * b_signed + smoothness_weight * s_signed;
                sigmoid(logit)
            })
            .collect();
        q = q_new;
    }

    println!(
        "CRF ({}x{}, {} iters, rad {}, {} fg / {} bg samples) took {:?}",
        width,
        height,
        iterations,
        rad_b,
        fg_samples.len(),
        bg_samples.len(),
        start.elapsed()
    );

    let out_fg: Vec<bool> = q.iter().map(|&p| p > 0.5).collect();
    Ok(Response::new(labels_to_mask(&out_fg)))
}

#[inline]
fn sigmoid(x: f32) -> f32 {
    1.0 / (1.0 + (-x).exp())
}

/// Evenly subsample reference colors at the given indices down to `max`.
fn subsample(rgb: &[[f32; 3]], idx: &[usize], max: usize) -> Vec<[f32; 3]> {
    if idx.is_empty() || max == 0 {
        return Vec::new();
    }
    let step = idx.len().div_ceil(max).max(1);
    idx.iter().step_by(step).map(|&i| rgb[i]).collect()
}

/// Euclidean RGB distance to the nearest reference color (0 if none).
fn min_dist(samples: &[[f32; 3]], c: [f32; 3]) -> f32 {
    let mut best = f32::MAX;
    for s in samples {
        let d = (c[0] - s[0]).powi(2) + (c[1] - s[1]).powi(2) + (c[2] - s[2]).powi(2);
        if d < best {
            best = d;
        }
    }
    if best == f32::MAX { 0.0 } else { best.sqrt() }
}

/// Pack a boolean foreground mask into a single-channel presence buffer
/// (255 = foreground, 0 = background). The frontend writes the active label /
/// instance value wherever this is nonzero.
fn labels_to_mask(fg: &[bool]) -> Vec<u8> {
    fg.iter().map(|&f| if f { 255u8 } else { 0 }).collect()
}
