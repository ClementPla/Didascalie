use crate::utils::color::{ciede2000, rgb_to_lab};
use std::collections::VecDeque;
use tauri::ipc::Response;

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
