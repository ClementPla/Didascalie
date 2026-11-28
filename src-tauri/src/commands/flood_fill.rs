use crate::commands::pixels::effective_settings;
use crate::commands::refine::{presence_bytes, refine, Refine};
use crate::pixels::cache::RawFrameCache;
use crate::pixels::display::Region;
use crate::pixels::intensity::{intensity_region, Source};
use crate::storage::DbState;
use crate::utils::color::{ciede2000, rgb_to_lab};
use ndarray::Array2;
use std::collections::VecDeque;
use tauri::{ipc::Response, State};

/// Flood fill from the last clicked pixel, bounded by the stroke's bounding
/// box. Shares its refinement options with `otsu_segmentation`; `inverse`
/// takes the complement of the fill within the region.
#[tauri::command]
pub fn flood_fill_mask(
    image: Vec<u8>,
    width: usize,
    height: usize,
    start_x: usize,
    start_y: usize,
    tolerance: f32,
    inverse: bool,
    smooth: f32,
    fill_holes: bool,
    connectedness: bool,
) -> Result<Response, String> {
    if start_x >= width || start_y >= height {
        return Err("Start point is outside image bounds".to_string());
    }
    if width.checked_mul(height).and_then(|n| n.checked_mul(4)) != Some(image.len()) {
        return Err(format!("Image buffer of {} bytes is not {width}×{height} RGBA", image.len()));
    }

    let seed_idx = (start_y * width + start_x) * 4;
    let seed_lab = rgb_to_lab(image[seed_idx], image[seed_idx + 1], image[seed_idx + 2]);
    let start_time = std::time::Instant::now();
    let output_mask = flood_region(width, height, start_y * width + start_x, |i| {
        let p = i * 4;
        ciede2000(seed_lab, rgb_to_lab(image[p], image[p + 1], image[p + 2])) <= tolerance
    });
    log::debug!(
        "Flood fill (CIEDE2000, tolerance {}) from ({}, {}) in {:.2}ms",
        tolerance,
        start_x,
        start_y,
        start_time.elapsed().as_secs_f64() * 1000.0
    );

    let selection = Array2::from_shape_fn((height, width), |(y, x)| {
        let filled = output_mask[y * width + x];
        if inverse { !filled } else { filled }
    });
    let selection = refine(
        &selection,
        &Refine { fill_holes, smooth, largest_only: connectedness },
    );
    Ok(Response::new(presence_bytes(&selection)))
}

/// The 8-connected region grown from `start` (always included) through the
/// pixels `accept` takes, as a `width * height` mask.
pub(crate) fn flood_region(width: usize, height: usize, start: usize, accept: impl Fn(usize) -> bool) -> Vec<bool> {
    const NEIGHBORS: [(i32, i32); 8] = [(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)];
    let mut selected = vec![false; width * height];
    let mut visited = vec![false; width * height];
    let mut queue = VecDeque::with_capacity(1024);
    queue.push_back(start);
    visited[start] = true;
    selected[start] = true;
    while let Some(i) = queue.pop_front() {
        let (x, y) = ((i % width) as i32, (i / width) as i32);
        for &(dx, dy) in &NEIGHBORS {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || nx >= width as i32 || ny < 0 || ny >= height as i32 {
                continue;
            }
            let ni = ny as usize * width + nx as usize;
            if visited[ni] {
                continue;
            }
            visited[ni] = true;
            if accept(ni) {
                selected[ni] = true;
                queue.push_back(ni);
            }
        }
    }
    selected
}

/// [`flood_fill_mask`] on raw pixels: grows through the intensity (0–1, the
/// display window applied) within `tolerance` % of the window of the clicked
/// pixel. For frames deeper than 8 bits, read from the raw cache.
#[tauri::command]
pub async fn flood_fill_raw(
    db: State<'_, DbState>,
    cache: State<'_, RawFrameCache>,
    frame_id: i64,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    start_x: usize,
    start_y: usize,
    source: Option<u32>,
    tolerance: f32,
    inverse: bool,
    smooth: f32,
    fill_holes: bool,
    connectedness: bool,
) -> Result<Response, String> {
    let (w, h) = (width as usize, height as usize);
    if start_x >= w || start_y >= h {
        return Err("Start point is outside the region".to_string());
    }
    let d = cache.get(&db, frame_id).map_err(|e| e.to_string())?;
    let settings = effective_settings(&db, &d, frame_id).map_err(|e| e.to_string())?;
    let region = Region { x, y, width, height }.bounded(d.frame.width, d.frame.height)?;
    let intensity = intensity_region(&d.frame, &settings, region, Source::from_option(source));
    let values = intensity.as_slice().ok_or("Intensity buffer is not contiguous")?;
    let seed = values[start_y * w + start_x];
    let limit = tolerance / 100.0;
    let filled = flood_region(w, h, start_y * w + start_x, |i| (values[i] - seed).abs() <= limit);

    let selection = Array2::from_shape_fn((h, w), |(r, c)| filled[r * w + c] != inverse);
    let selection = refine(&selection, &Refine { fill_holes, smooth, largest_only: connectedness });
    Ok(Response::new(presence_bytes(&selection)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flood_region_stops_at_pixels_it_does_not_accept() {
        // 4×3; column 2 is a wall, except a gap on the bottom row.
        let wall = [2, 6];
        let filled = flood_region(4, 3, 0, |i| !wall.contains(&i));
        let expected = [
            true, true, false, true, //
            true, true, false, true, //
            true, true, true, true,
        ];
        assert_eq!(filled, expected);
        let closed = flood_region(4, 3, 0, |i| i % 4 != 2);
        assert!(!closed[3] && closed[8]);
    }
}
