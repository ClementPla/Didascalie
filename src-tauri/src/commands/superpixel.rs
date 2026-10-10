use crate::superpixel::SuperpixelMap;
use parking_lot::Mutex;
use tauri::ipc::Response;
use tauri::State;

/// The superpixel map of the current image. `None` until the first stroke
/// computes it; the frontend resets it when the image changes.
pub type SuperpixelState = Mutex<Option<SuperpixelMap>>;

/// Refine a brush stroke by snapping it to superpixel boundaries. The first
/// stroke on an image passes `compute_map: true` and the full `image`; later
/// ones reuse the cached map.
#[tauri::command]
pub async fn superpixel_refine(
    image: Vec<u8>,
    brush: Vec<u8>,
    width: usize,
    height: usize,
    compute_map: bool,
    target_count: usize,
    similarity_threshold: f32,
    min_overlap_fraction: f32,
    state: State<'_, SuperpixelState>,
) -> Result<Response, String> {
    // Rebuild when asked, or when the cached map does not match the image size.
    {
        let mut guard = state.lock();
        let needs_compute = compute_map
            || guard
                .as_ref()
                .map_or(true, |m| !m.matches(width, height));
        if needs_compute {
            let map = SuperpixelMap::compute(&image, width, height, target_count)?;
            println!(
                "Computed {} superpixels for {}x{} image",
                map.num_superpixels(),
                width,
                height
            );
            *guard = Some(map);
        }
    }

    let guard = state.lock();
    let map = guard
        .as_ref()
        .ok_or("Superpixel map is not available")?;

    let mask = map.refine(&brush, similarity_threshold, min_overlap_fraction)?;

    // Single-channel presence mask (255 = included).
    let output: Vec<u8> = mask
        .iter()
        .map(|&included| if included { 255u8 } else { 0 })
        .collect();

    Ok(Response::new(output))
}

/// The superpixel boundaries as an RGBA overlay. Builds the map on demand.
#[tauri::command]
pub async fn superpixel_overlay(
    image: Vec<u8>,
    width: usize,
    height: usize,
    compute_map: bool,
    target_count: usize,
    state: State<'_, SuperpixelState>,
) -> Result<Response, String> {
    {
        let mut guard = state.lock();
        let needs_compute = compute_map
            || guard
                .as_ref()
                .map_or(true, |m| !m.matches(width, height));
        if needs_compute {
            let map = SuperpixelMap::compute(&image, width, height, target_count)?;
            *guard = Some(map);
        }
    }

    let guard = state.lock();
    let map = guard
        .as_ref()
        .ok_or("Superpixel map is not available")?;

    Ok(Response::new(map.boundary_overlay([255, 225, 0, 180])))
}
