//! Convert a raster label component into its centerline skeleton for the
//! editor's "skeletonize" tool. Unlike vectorize (which traces the closed outer
//! contour), this thins the component to a 1px skeleton and splits it at
//! endpoints/junctions into open polylines.

use crate::commands::formats::geometry;

/// Skeletonize the connected component of `mask` under pixel `(x, y)` into open
/// centerline polylines (image-pixel coordinates). Returns an empty list when
/// the clicked pixel is background.
#[tauri::command]
pub fn skeletonize_component(
    mask: Vec<u8>,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
) -> Vec<Vec<[f64; 2]>> {
    geometry::component_skeleton_paths(&mask, width, height, x, y)
}
