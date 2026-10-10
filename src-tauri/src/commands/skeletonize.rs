//! Raster label component to centreline polylines, for the "skeletonize"
//! tool.

use crate::commands::formats::geometry;

/// Skeletonize the component of `mask` under `(x, y)` into open polylines.
/// Empty when the pixel is background.
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

/// Skeletonize every component of `mask`. `min_area` and `max_shapes` behave
/// as in `vectorize_mask`.
#[tauri::command]
pub fn skeletonize_mask(
    mask: Vec<u8>,
    width: u32,
    height: u32,
    min_area: u32,
    max_shapes: usize,
) -> Vec<Vec<[f64; 2]>> {
    geometry::mask_skeleton_paths(&mask, width, height, min_area, max_shapes)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two separated horizontal bars: a long thick one and a short thin one.
    fn two_bars(w: u32, h: u32) -> Vec<u8> {
        let mut m = vec![0u8; (w * h) as usize];
        for y in 4..=8u32 {
            for x in 2..=40u32 {
                m[(y * w + x) as usize] = 1;
            }
        }
        for y in 20..=21u32 {
            for x in 5..=14u32 {
                m[(y * w + x) as usize] = 1;
            }
        }
        m
    }

    #[test]
    fn every_component_gets_a_centerline() {
        let paths = skeletonize_mask(two_bars(48, 32), 48, 32, 0, 0);
        assert_eq!(paths.len(), 2, "one centerline per bar");
    }

    #[test]
    fn min_area_drops_the_small_bar() {
        // The thick bar is 5x39 = 195px; the thin one 2x10 = 20px.
        let paths = skeletonize_mask(two_bars(48, 32), 48, 32, 50, 0);
        assert_eq!(paths.len(), 1);
    }

    #[test]
    fn the_cap_keeps_the_largest_component() {
        let paths = skeletonize_mask(two_bars(48, 32), 48, 32, 0, 1);
        assert_eq!(paths.len(), 1);
        let xs: Vec<f64> = paths[0].iter().map(|p| p[0]).collect();
        let span = xs.iter().copied().fold(f64::MIN, f64::max)
            - xs.iter().copied().fold(f64::MAX, f64::min);
        assert!(span > 15.0, "cap kept the short bar instead of the long one");
    }

    #[test]
    fn an_empty_mask_yields_nothing() {
        assert!(skeletonize_mask(vec![0u8; 32 * 32], 32, 32, 0, 0).is_empty());
    }
}
