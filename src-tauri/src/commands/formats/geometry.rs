//! Derive object geometry (bounding boxes + polygons) from label value masks.
//! Object formats (COCO, YOLO) consume these; mask/volume formats (NIfTI) use
//! the raw masks directly.

use image::{GrayImage, Luma};
use imageproc::contours::{find_contours, BorderType};
use imageproc::region_labelling::{connected_components, Connectivity};

/// One object extracted from a label mask.
pub struct Region {
    /// Instance id (mask value) for instance labels, else 1.
    pub instance: u8,
    /// x, y, width, height in image pixels.
    pub bbox: [f64; 4],
    pub area: u32,
    /// Outer contour rings, image-pixel coordinates.
    pub polygons: Vec<Vec<[f64; 2]>>,
}

/// Split a label's value mask into per-object regions.
///
/// - `by_instance` (instance segmentation): one region per distinct nonzero
///   value (the instance id).
/// - otherwise (semantic): one region per 8-connected component of the
///   presence, which is the object granularity COCO/YOLO expect.
pub fn regions_from_mask(values: &[u8], w: u32, h: u32, by_instance: bool) -> Vec<Region> {
    let (wu, hu) = (w as usize, h as usize);
    if values.len() < wu * hu || w == 0 || h == 0 {
        return Vec::new();
    }
    let mut regions = Vec::new();

    if by_instance {
        let mut ids: Vec<u8> = values.iter().copied().filter(|&v| v != 0).collect();
        ids.sort_unstable();
        ids.dedup();
        for id in ids {
            let bin: Vec<u8> = values.iter().map(|&v| if v == id { 255 } else { 0 }).collect();
            if let Some(mut r) = region_from_binary(&bin, w, h) {
                r.instance = id;
                regions.push(r);
            }
        }
    } else {
        let presence: Vec<u8> = values.iter().map(|&v| if v != 0 { 255 } else { 0 }).collect();
        let Some(img) = GrayImage::from_raw(w, h, presence) else {
            return regions;
        };
        let cc = connected_components(&img, Connectivity::Eight, Luma([0u8]));
        let max_label = cc.pixels().map(|p| p[0]).max().unwrap_or(0);
        for label in 1..=max_label {
            let bin: Vec<u8> =
                cc.pixels().map(|p| if p[0] == label { 255 } else { 0 }).collect();
            if let Some(mut r) = region_from_binary(&bin, w, h) {
                r.instance = 1;
                regions.push(r);
            }
        }
    }
    regions
}

fn region_from_binary(bin: &[u8], w: u32, h: u32) -> Option<Region> {
    let (mut minx, mut miny, mut maxx, mut maxy) = (u32::MAX, u32::MAX, 0u32, 0u32);
    let mut area = 0u32;
    for y in 0..h {
        for x in 0..w {
            if bin[(y * w + x) as usize] != 0 {
                area += 1;
                minx = minx.min(x);
                miny = miny.min(y);
                maxx = maxx.max(x);
                maxy = maxy.max(y);
            }
        }
    }
    if area == 0 {
        return None;
    }

    let img = GrayImage::from_raw(w, h, bin.to_vec())?;
    let mut polygons = Vec::new();
    for c in find_contours::<u32>(&img) {
        if c.border_type == BorderType::Outer && c.points.len() >= 3 {
            let ring: Vec<[f64; 2]> =
                c.points.iter().map(|p| [p.x as f64, p.y as f64]).collect();
            let simplified = douglas_peucker(&ring, 1.5);
            if simplified.len() >= 3 {
                polygons.push(simplified);
            }
        }
    }

    Some(Region {
        instance: 1,
        bbox: [
            minx as f64,
            miny as f64,
            (maxx - minx + 1) as f64,
            (maxy - miny + 1) as f64,
        ],
        area,
        polygons,
    })
}

/// Trace the outer contour(s) of the 8-connected, same-value component that
/// contains the seed pixel `(sx, sy)`. Returns simplified polygon rings in
/// image-pixel coordinates, or empty when the seed is background / out of range.
///
/// Same-value flooding (not just nonzero) keeps two touching instances in an
/// instance mask separate, matching how the frontend clears the traced pixels.
pub fn component_polygons(values: &[u8], w: u32, h: u32, sx: u32, sy: u32) -> Vec<Vec<[f64; 2]>> {
    let (wu, hu) = (w as usize, h as usize);
    if values.len() < wu * hu || sx >= w || sy >= h {
        return Vec::new();
    }
    let seed = values[(sy * w + sx) as usize];
    if seed == 0 {
        return Vec::new();
    }

    // Flood the same-value component into a binary mask (255 = in component).
    let mut bin = vec![0u8; values.len()];
    let mut stack = vec![(sx, sy)];
    bin[(sy * w + sx) as usize] = 255;
    while let Some((x, y)) = stack.pop() {
        for dy in -1i64..=1 {
            for dx in -1i64..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = x as i64 + dx;
                let ny = y as i64 + dy;
                if nx < 0 || ny < 0 || nx >= w as i64 || ny >= h as i64 {
                    continue;
                }
                let ni = (ny as u32 * w + nx as u32) as usize;
                if bin[ni] == 0 && values[ni] == seed {
                    bin[ni] = 255;
                    stack.push((nx as u32, ny as u32));
                }
            }
        }
    }

    region_from_binary(&bin, w, h)
        .map(|r| r.polygons)
        .unwrap_or_default()
}

/// Axis-aligned bounds `[x, y, w, h]` of a polygon.
pub fn polygon_bounds(points: &[[f64; 2]]) -> [f64; 4] {
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for p in points {
        minx = minx.min(p[0]);
        miny = miny.min(p[1]);
        maxx = maxx.max(p[0]);
        maxy = maxy.max(p[1]);
    }
    if points.is_empty() {
        return [0.0, 0.0, 0.0, 0.0];
    }
    [minx, miny, maxx - minx, maxy - miny]
}

/// Douglas–Peucker polyline simplification. Contours are pixel-dense; this trims
/// collinear runs so exported polygons are compact.
fn douglas_peucker(pts: &[[f64; 2]], epsilon: f64) -> Vec<[f64; 2]> {
    if pts.len() < 3 {
        return pts.to_vec();
    }
    let (first, last) = (pts[0], pts[pts.len() - 1]);
    let mut idx = 0;
    let mut dmax = 0.0;
    for i in 1..pts.len() - 1 {
        let d = perp_distance(pts[i], first, last);
        if d > dmax {
            dmax = d;
            idx = i;
        }
    }
    if dmax > epsilon {
        let mut left = douglas_peucker(&pts[..=idx], epsilon);
        let right = douglas_peucker(&pts[idx..], epsilon);
        left.pop();
        left.extend(right);
        left
    } else {
        vec![first, last]
    }
}

fn perp_distance(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
    let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
    let len = (dx * dx + dy * dy).sqrt();
    if len == 0.0 {
        return ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2)).sqrt();
    }
    (dx * (a[1] - p[1]) - (a[0] - p[0]) * dy).abs() / len
}
