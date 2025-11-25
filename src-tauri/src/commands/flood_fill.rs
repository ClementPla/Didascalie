use std::collections::VecDeque;
use tauri::ipc::Response;

static GAMMA_LUT: once_cell::sync::Lazy<[f32; 256]> = once_cell::sync::Lazy::new(|| {
    let mut lut = [0.0f32; 256];
    for i in 0..256 {
        let v = i as f32 / 255.0;
        lut[i] = if v > 0.04045 {
            ((v + 0.055) / 1.055).powf(2.4)
        } else {
            v / 12.92
        };
    }
    lut
});

const LAB_THRESHOLD: f32 = 0.008856;
const LAB_T0: f32 = 0.137931;

#[inline(always)]
fn xyz_to_lab_component(t: f32) -> f32 {
    if t > LAB_THRESHOLD {
        t.powf(1.0 / 3.0)
    } else {
        7.787 * t + LAB_T0
    }
}

#[inline]
fn rgb_to_lab(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let r = GAMMA_LUT[r as usize];
    let g = GAMMA_LUT[g as usize];
    let b = GAMMA_LUT[b as usize];

    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;

    let fx = xyz_to_lab_component(x);
    let fy = xyz_to_lab_component(y);
    let fz = xyz_to_lab_component(z);

    let l = 116.0 * fy - 16.0;
    let a = 500.0 * (fx - fy);
    let b = 200.0 * (fy - fz);

    (l, a, b)
}

// CIEDE2000 color difference formula
#[inline]
fn ciede2000(lab1: (f32, f32, f32), lab2: (f32, f32, f32)) -> f32 {
    let (l1, a1, b1) = lab1;
    let (l2, a2, b2) = lab2;

    // Calculate C (chroma) and h (hue)
    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_avg = (c1 + c2) / 2.0;

    // Calculate G factor for a' correction
    let c_avg_7 = c_avg.powi(7);
    let g = 0.5 * (1.0 - (c_avg_7 / (c_avg_7 + 25.0_f32.powi(7))).sqrt());

    // Calculate a' (modified a)
    let a1_prime = a1 * (1.0 + g);
    let a2_prime = a2 * (1.0 + g);

    // Calculate C' (modified chroma)
    let c1_prime = (a1_prime * a1_prime + b1 * b1).sqrt();
    let c2_prime = (a2_prime * a2_prime + b2 * b2).sqrt();

    // Calculate h' (modified hue)
    let h1_prime = if b1 == 0.0 && a1_prime == 0.0 {
        0.0
    } else {
        let h = b1.atan2(a1_prime).to_degrees();
        if h < 0.0 {
            h + 360.0
        } else {
            h
        }
    };

    let h2_prime = if b2 == 0.0 && a2_prime == 0.0 {
        0.0
    } else {
        let h = b2.atan2(a2_prime).to_degrees();
        if h < 0.0 {
            h + 360.0
        } else {
            h
        }
    };

    // Calculate differences
    let delta_l = l2 - l1;
    let delta_c_prime = c2_prime - c1_prime;

    // Calculate hue difference
    let delta_h_prime = if c1_prime * c2_prime == 0.0 {
        0.0
    } else {
        let diff = h2_prime - h1_prime;
        if diff.abs() <= 180.0 {
            diff
        } else if diff > 180.0 {
            diff - 360.0
        } else {
            diff + 360.0
        }
    };

    let delta_big_h_prime =
        2.0 * (c1_prime * c2_prime).sqrt() * (delta_h_prime.to_radians() / 2.0).sin();

    // Calculate averages for weighting factors
    let l_avg = (l1 + l2) / 2.0;
    let c_prime_avg = (c1_prime + c2_prime) / 2.0;

    let h_prime_avg = if c1_prime * c2_prime == 0.0 {
        h1_prime + h2_prime
    } else {
        let sum = h1_prime + h2_prime;
        if (h1_prime - h2_prime).abs() <= 180.0 {
            sum / 2.0
        } else if sum < 360.0 {
            (sum + 360.0) / 2.0
        } else {
            (sum - 360.0) / 2.0
        }
    };

    // Calculate weighting factors
    let t = 1.0 - 0.17 * ((h_prime_avg - 30.0).to_radians()).cos()
        + 0.24 * ((2.0 * h_prime_avg).to_radians()).cos()
        + 0.32 * ((3.0 * h_prime_avg + 6.0).to_radians()).cos()
        - 0.20 * ((4.0 * h_prime_avg - 63.0).to_radians()).cos();

    let s_l = 1.0 + (0.015 * (l_avg - 50.0).powi(2)) / (20.0 + (l_avg - 50.0).powi(2)).sqrt();
    let s_c = 1.0 + 0.045 * c_prime_avg;
    let s_h = 1.0 + 0.015 * c_prime_avg * t;

    let r_t = -2.0
        * (c_prime_avg.powi(7) / (c_prime_avg.powi(7) + 25.0_f32.powi(7))).sqrt()
        * ((60.0 * (-(((h_prime_avg - 275.0) / 25.0).powi(2)))).exp())
            .sin()
            .to_radians();

    // Calculate final delta E
    let k_l = 1.0;
    let k_c = 1.0;
    let k_h = 1.0;

    let delta_e = ((delta_l / (k_l * s_l)).powi(2)
        + (delta_c_prime / (k_c * s_c)).powi(2)
        + (delta_big_h_prime / (k_h * s_h)).powi(2)
        + r_t * (delta_c_prime / (k_c * s_c)) * (delta_big_h_prime / (k_h * s_h)))
        .sqrt();

    delta_e
}

#[tauri::command]
pub fn flood_fill_mask(
    image: Vec<u8>,
    width: usize,
    height: usize,
    start_x: usize,
    start_y: usize,
    tolerance: f32,
) -> Result<Response, String> {
    if start_x >= width || start_y >= height {
        return Err("Start point is outside image bounds".to_string());
    }

    let total_pixels = width * height;
    let mut output_mask = vec![false; total_pixels];
    let mut visited = vec![false; total_pixels];

    let seed_idx = (start_y * width + start_x) * 4;
    let seed_r = image[seed_idx];
    let seed_g = image[seed_idx + 1];
    let seed_b = image[seed_idx + 2];
    let seed_lab = rgb_to_lab(seed_r, seed_g, seed_b);

    println!(
        "Flood fill (CIEDE2000) from ({}, {}) tolerance {}, seed RGB({},{},{})",
        start_x, start_y, tolerance, seed_r, seed_g, seed_b
    );

    let start_time = std::time::Instant::now();

    let mut queue = VecDeque::with_capacity(1024);
    let start_i = start_y * width + start_x;
    queue.push_back(start_i);
    visited[start_i] = true;
    output_mask[start_i] = true;

    let mut filled_pixels = 1usize;

    const NEIGHBORS: [(i32, i32); 8] = [
        (-1, -1),
        (0, -1),
        (1, -1),
        (-1, 0),
        (1, 0),
        (-1, 1),
        (0, 1),
        (1, 1),
    ];

    while let Some(i) = queue.pop_front() {
        let x = i % width;
        let y = i / width;

        for &(dx, dy) in &NEIGHBORS {
            let nx = x as i32 + dx;
            let ny = y as i32 + dy;

            if nx < 0 || nx >= width as i32 || ny < 0 || ny >= height as i32 {
                continue;
            }

            let ni = ny as usize * width + nx as usize;

            if visited[ni] {
                continue;
            }

            visited[ni] = true;

            let pixel_idx = ni * 4;
            let nr = image[pixel_idx];
            let ng = image[pixel_idx + 1];
            let nb = image[pixel_idx + 2];

            let neighbor_lab = rgb_to_lab(nr, ng, nb);

            // Use CIEDE2000
            let delta_e = ciede2000(seed_lab, neighbor_lab);

            if delta_e <= tolerance {
                output_mask[ni] = true;
                filled_pixels += 1;
                queue.push_back(ni);
            }
        }
    }

    let elapsed = start_time.elapsed();
    println!(
        "Flood fill complete: {} pixels in {:.2}ms",
        filled_pixels,
        elapsed.as_secs_f64() * 1000.0
    );

    let mut output_data = Vec::with_capacity(total_pixels * 4);
    for &filled in &output_mask {
        if filled {
            output_data.extend_from_slice(&[255, 255, 255, 255]);
        } else {
            output_data.extend_from_slice(&[0, 0, 0, 0]);
        }
    }

    Ok(Response::new(output_data))
}
