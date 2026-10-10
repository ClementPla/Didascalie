//! Raster label pixels to vector polygons, for the "vectorize" tool.

use crate::commands::formats::geometry;

/// Trace the component of `mask` under `(x, y)` into simplified outer-contour
/// polygons. Empty when the pixel is background.
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

/// Trace every component of `mask` into simplified polygons. `min_area`
/// drops specks below a pixel count (0 keeps everything).
#[tauri::command]
pub fn vectorize_mask(
    mask: Vec<u8>,
    width: u32,
    height: u32,
    min_area: u32,
    max_shapes: usize,
) -> Vec<Vec<[f64; 2]>> {
    // A predicted mask is one class: every connected blob is an object.
    let mut regions = geometry::regions_from_mask(&mask, width, height, false);
    // Largest first, so the cap keeps the main structures.
    regions.sort_by(|a, b| b.area.cmp(&a.area));
    regions
        .into_iter()
        .filter(|r| r.area >= min_area)
        .take(if max_shapes == 0 { usize::MAX } else { max_shapes })
        .flat_map(|r| r.polygons)
        .filter(|p| p.len() >= 3)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `w`x`h` mask with `n` disconnected 3x3 blocks in a row, plus one larger
    /// block, so area ordering is unambiguous.
    fn speckled(w: u32, h: u32, n: u32) -> Vec<u8> {
        let mut m = vec![0u8; (w * h) as usize];
        let put = |m: &mut Vec<u8>, x0: u32, y0: u32, s: u32| {
            for y in y0..(y0 + s).min(h) {
                for x in x0..(x0 + s).min(w) {
                    m[(y * w + x) as usize] = 1;
                }
            }
        };
        put(&mut m, 1, 1, 9); // the big one
        for i in 0..n {
            // Spaced by 4 so 8-connectivity cannot join them.
            put(&mut m, 15 + i * 4, 15, 2);
        }
        m
    }

    #[test]
    fn every_component_becomes_its_own_polygon() {
        let polys = vectorize_mask(speckled(64, 64, 3), 64, 64, 0, 0);
        assert_eq!(polys.len(), 4, "one big block plus three specks");
    }

    #[test]
    fn the_cap_keeps_the_largest_components() {
        let polys = vectorize_mask(speckled(64, 64, 6), 64, 64, 0, 1);
        assert_eq!(polys.len(), 1, "capped to one shape");
        // The 9x9 block spans further than any 2x2 speck.
        let xs: Vec<f64> = polys[0].iter().map(|p| p[0]).collect();
        let span = xs.iter().cloned().fold(f64::MIN, f64::max)
            - xs.iter().cloned().fold(f64::MAX, f64::min);
        assert!(span > 4.0, "cap kept a speck instead of the big block");
    }

    #[test]
    fn min_area_drops_specks() {
        // 2x2 specks are area 4; the 9x9 block is 81.
        let polys = vectorize_mask(speckled(64, 64, 6), 64, 64, 10, 0);
        assert_eq!(polys.len(), 1, "only the large component survives");
    }

    #[test]
    fn an_empty_mask_yields_nothing() {
        assert!(vectorize_mask(vec![0u8; 32 * 32], 32, 32, 0, 0).is_empty());
    }
}
