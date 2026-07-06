//! Convert raster label pixels into vector polygons for the editor's
//! "vectorize" tool. Reuses the contour + Douglas–Peucker geometry that the
//! COCO/YOLO exporters already rely on.

use crate::commands::formats::geometry;

/// Trace the connected component of `mask` under pixel `(x, y)` into simplified
/// outer-contour polygons (image-pixel coordinates). Returns an empty list when
/// the clicked pixel is background.
#[tauri::command]
pub fn vectorize_component(
    mask: Vec<u8>,
    width: u32,
    height: u32,
    x: u32,
    y: u32,
) -> Vec<Vec<[f64; 2]>> {
    geometry::component_polygons(&mask, width, height, x, y)
}
