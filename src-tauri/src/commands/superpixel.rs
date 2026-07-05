use crate::superpixel::SuperpixelMap;
use parking_lot::Mutex;
use tauri::ipc::Response;
use tauri::State;

/// Managed state holding the cached superpixel map for the current image.
/// `None` until the first stroke computes it (reset from the frontend when the
/// image changes, like the SAM `featuresExtracted` flag).
pub type SuperpixelState = Mutex<Option<SuperpixelMap>>;

/// Refine a brush stroke by snapping it to superpixel boundaries.
///
/// On the first stroke for an image the caller passes `compute_map: true` (and
/// the full `image` buffer) to build and cache the oversegmentation; subsequent
/// strokes pass `compute_map: false` and reuse the cache.
///
/// Returns an RGBA mask (white where included, transparent elsewhere) matching
/// the flood-fill / otsu command output convention.
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
    // Build (or rebuild) the cached map when requested or when the cached one no
    // longer matches the image dimensions.
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

    // Single-channel presence mask (255 = included). The frontend writes the
    // active label / instance value wherever this is nonzero.
    let output: Vec<u8> = mask
        .iter()
        .map(|&included| if included { 255u8 } else { 0 })
        .collect();

    Ok(Response::new(output))
}

/// Render the cached superpixel boundaries as an RGBA overlay for display.
///
/// Builds (or rebuilds) the map on demand — so the overlay can be toggled on
/// before the first stroke — then returns a transparent image with only the
/// superpixel edges drawn.
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

    // Semi-transparent yellow edges.
    Ok(Response::new(map.boundary_overlay([255, 225, 0, 180])))
}
