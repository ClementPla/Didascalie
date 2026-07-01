//! Superpixel-based brush refinement.
//!
//! A SLIC oversegmentation of the image is computed once per image (mirroring
//! the SAM encoder-feature caching in `dl::feature_extract`) and held in Tauri
//! managed state. When the user strokes a brush over a region, the refinement
//! finds the dominant color under the stroke, seeds from the confidently-covered
//! superpixels, and grows outward across the superpixel adjacency graph to every
//! connected superpixel of the same color. This lets a short, light stroke
//! select a whole homogeneous region instead of only the pixels drawn over,
//! while still stopping at color edges so it doesn't bleed into other regions.

use crate::utils::color::{ciede2000, rgb_to_lab, Lab};
use ndarray::Array2;
use rayon::prelude::*;
use std::collections::VecDeque;

/// A cached oversegmentation of one image plus per-superpixel statistics.
pub struct SuperpixelMap {
    /// Per-pixel superpixel id, shape `(height, width)`.
    labels: Array2<u32>,
    /// Mean CIELAB color per superpixel, indexed by id.
    lab_means: Vec<Lab>,
    /// Pixel count per superpixel, indexed by id.
    sizes: Vec<u32>,
    /// 4-connected neighbor ids per superpixel (sorted, deduplicated).
    adjacency: Vec<Vec<u32>>,
    width: usize,
    height: usize,
}

impl SuperpixelMap {
    pub fn num_superpixels(&self) -> usize {
        self.lab_means.len()
    }

    /// True when this map already matches the given image dimensions and can be
    /// reused instead of recomputed.
    pub fn matches(&self, width: usize, height: usize) -> bool {
        self.width == width && self.height == height
    }

    /// Compute the oversegmentation for an RGBA image and cache per-superpixel
    /// mean color, size, and adjacency.
    ///
    /// `target_count` is the desired (approximate) number of superpixels.
    pub fn compute(
        image_rgba: &[u8],
        width: usize,
        height: usize,
        target_count: usize,
    ) -> Result<Self, String> {
        if image_rgba.len() != width * height * 4 {
            return Err(format!(
                "Image buffer does not match dimensions {}x{} (expected {} bytes, got {})",
                width,
                height,
                width * height * 4,
                image_rgba.len()
            ));
        }

        // Precompute per-pixel Lab once; reused by SLIC and the mean stats.
        let lab: Vec<Lab> = (0..width * height)
            .into_par_iter()
            .map(|i| {
                let px = i * 4;
                rgb_to_lab(image_rgba[px], image_rgba[px + 1], image_rgba[px + 2])
            })
            .collect();

        let (labels, num_superpixels) = slic(&lab, width, height, target_count);

        // Accumulate per-superpixel Lab sums and counts in one pass.
        let mut lab_sums = vec![(0.0f64, 0.0f64, 0.0f64); num_superpixels];
        let mut sizes = vec![0u32; num_superpixels];
        for (i, &id) in labels.iter().enumerate() {
            let (l, a, b) = lab[i];
            let acc = &mut lab_sums[id as usize];
            acc.0 += l as f64;
            acc.1 += a as f64;
            acc.2 += b as f64;
            sizes[id as usize] += 1;
        }

        let lab_means: Vec<Lab> = lab_sums
            .iter()
            .zip(sizes.iter())
            .map(|(&(sl, sa, sb), &n)| {
                if n == 0 {
                    (0.0, 0.0, 0.0)
                } else {
                    let n = n as f64;
                    ((sl / n) as f32, (sa / n) as f32, (sb / n) as f32)
                }
            })
            .collect();

        let adjacency = build_adjacency(&labels, num_superpixels, width, height);

        Ok(SuperpixelMap {
            labels,
            lab_means,
            sizes,
            adjacency,
            width,
            height,
        })
    }

    /// Refine a brush stroke into a region selection.
    ///
    /// `brush_rgba` is the stroke rendered as an RGBA buffer; a pixel counts as
    /// covered when its alpha byte is `> 128` (same convention as the mask
    /// helpers elsewhere).
    ///
    /// Returns a per-pixel boolean inclusion mask, row-major `height * width`.
    ///
    /// Algorithm:
    /// 1. Tally stroke overlap per superpixel; the dominant color is the
    ///    overlap-area-weighted mean color of the covered superpixels.
    /// 2. Seed from superpixels the stroke covers by at least
    ///    `min_overlap_fraction` whose mean color is within
    ///    `similarity_threshold` (CIEDE2000) of the dominant.
    /// 3. Grow the selection over the superpixel adjacency graph, adding any
    ///    connected superpixel also within the color threshold. Growth stops at
    ///    color edges, so the result is the connected same-color region the
    ///    stroke lands in — even from a light stroke.
    ///
    /// If the stroke is too light to seed anything, falls back to every touched
    /// superpixel within the color threshold (no growth).
    pub fn refine(
        &self,
        brush_rgba: &[u8],
        similarity_threshold: f32,
        min_overlap_fraction: f32,
    ) -> Result<Vec<bool>, String> {
        let total = self.width * self.height;
        if brush_rgba.len() != total * 4 {
            return Err(format!(
                "Brush buffer does not match dimensions {}x{} (expected {} bytes, got {})",
                self.width,
                self.height,
                total * 4,
                brush_rgba.len()
            ));
        }

        let n_sp = self.num_superpixels();

        // 1. Tally how many stroke pixels fall in each superpixel.
        let mut overlap = vec![0u32; n_sp];
        for (i, &id) in self.labels.iter().enumerate() {
            if brush_rgba[i * 4 + 3] > 128 {
                overlap[id as usize] += 1;
            }
        }

        // 2. Dominant color = overlap-area-weighted mean of covered superpixels.
        let (mut wl, mut wa, mut wb, mut wsum) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for (id, &count) in overlap.iter().enumerate() {
            if count == 0 {
                continue;
            }
            let w = count as f64;
            let (l, a, b) = self.lab_means[id];
            wl += w * l as f64;
            wa += w * a as f64;
            wb += w * b as f64;
            wsum += w;
        }
        if wsum == 0.0 {
            return Ok(vec![false; total]); // stroke covered nothing
        }
        let dominant: Lab = ((wl / wsum) as f32, (wa / wsum) as f32, (wb / wsum) as f32);
        let close = |id: usize| ciede2000(self.lab_means[id], dominant) < similarity_threshold;

        // 3. Seed from confidently-covered, color-matching superpixels.
        let mut included = vec![false; n_sp];
        let mut queue: VecDeque<usize> = VecDeque::new();
        for id in 0..n_sp {
            if overlap[id] == 0 {
                continue;
            }
            let frac = overlap[id] as f32 / self.sizes[id].max(1) as f32;
            if frac >= min_overlap_fraction && close(id) {
                included[id] = true;
                queue.push_back(id);
            }
        }

        if queue.is_empty() {
            // Fallback: nothing crossed the overlap threshold. Keep any touched
            // superpixel that matches color, so a very light stroke still acts.
            for id in 0..n_sp {
                if overlap[id] > 0 && close(id) {
                    included[id] = true;
                }
            }
        } else {
            // Grow across the adjacency graph within the color threshold.
            while let Some(id) = queue.pop_front() {
                for &nb in &self.adjacency[id] {
                    let nb = nb as usize;
                    if !included[nb] && close(nb) {
                        included[nb] = true;
                        queue.push_back(nb);
                    }
                }
            }
        }

        // 4. Rasterize included superpixels to a per-pixel mask.
        let out = self
            .labels
            .iter()
            .map(|&id| included[id as usize])
            .collect();
        Ok(out)
    }

    /// Render superpixel boundaries as an RGBA overlay.
    ///
    /// A pixel is drawn when its right or bottom neighbor belongs to a different
    /// superpixel, giving a thin 1px edge on one side of each boundary. Boundary
    /// pixels get `color`; all others are fully transparent.
    pub fn boundary_overlay(&self, color: [u8; 4]) -> Vec<u8> {
        let (h, w) = (self.height, self.width);
        let labels = &self.labels;
        let mut out = vec![0u8; w * h * 4];

        for y in 0..h {
            for x in 0..w {
                let id = labels[[y, x]];
                let edge = (x + 1 < w && labels[[y, x + 1]] != id)
                    || (y + 1 < h && labels[[y + 1, x]] != id);
                if edge {
                    let px = (y * w + x) * 4;
                    out[px..px + 4].copy_from_slice(&color);
                }
            }
        }
        out
    }
}

/// SLIC compactness `m`: higher values weight spatial proximity more, giving
/// squarer, more regular superpixels; lower values follow color edges more
/// tightly. 10 is the value recommended in the SLIC paper.
const SLIC_COMPACTNESS: f32 = 10.0;
/// Number of assignment/update passes. SLIC converges quickly; 10 is standard.
const SLIC_ITERATIONS: usize = 10;

#[derive(Clone, Copy)]
struct Center {
    l: f32,
    a: f32,
    b: f32,
    x: f32,
    y: f32,
}

/// SLIC superpixel oversegmentation (Achanta et al., 2012).
///
/// Operates on a precomputed per-pixel CIELAB buffer. Cluster centers are seeded
/// on a regular `cols x rows` grid; each pass assigns every pixel to the nearest
/// center among the 3x3 block of grid cells around it (centers drift at most ~S,
/// so the true nearest is always in that block) under the combined color+space
/// distance `D^2 = dc^2 + (m/S)^2 * ds^2`, then recomputes centers as the mean
/// of their members. The assignment pass is parallelized over pixels with rayon.
/// A final pass enforces connectivity and relabels segments contiguously.
///
/// Returns the label map and the number of superpixels.
fn slic(lab: &[Lab], width: usize, height: usize, target_count: usize) -> (Array2<u32>, usize) {
    let n = width * height;
    let k = target_count.max(1);
    let s = (n as f32 / k as f32).sqrt().max(1.0);

    let cols = ((width as f32 / s).round() as usize).max(1);
    let rows = ((height as f32 / s).round() as usize).max(1);
    let cell_w = width as f32 / cols as f32;
    let cell_h = height as f32 / rows as f32;

    // Seed centers at the middle of each grid cell.
    let mut centers: Vec<Center> = Vec::with_capacity(rows * cols);
    for r in 0..rows {
        for c in 0..cols {
            let cx = (c as f32 + 0.5) * cell_w;
            let cy = (r as f32 + 0.5) * cell_h;
            let xi = (cx as usize).min(width - 1);
            let yi = (cy as usize).min(height - 1);
            let (l, a, b) = lab[yi * width + xi];
            centers.push(Center { l, a, b, x: cx, y: cy });
        }
    }

    let inv_s2 = (SLIC_COMPACTNESS / s).powi(2); // (m/S)^2 spatial weight
    let mut labels = vec![0u32; n];

    for _ in 0..SLIC_ITERATIONS {
        // Assignment: parallel over pixels, each independently picks the nearest
        // center in its 3x3 grid-cell neighborhood.
        labels
            .par_iter_mut()
            .enumerate()
            .for_each(|(idx, out)| {
                let x = (idx % width) as f32;
                let y = (idx / width) as f32;
                let (pl, pa, pb) = lab[idx];
                let gc = (x / cell_w) as isize;
                let gr = (y / cell_h) as isize;

                let mut best = f32::MAX;
                let mut best_ci = 0u32;
                for rr in (gr - 1)..=(gr + 1) {
                    if rr < 0 || rr >= rows as isize {
                        continue;
                    }
                    for cc in (gc - 1)..=(gc + 1) {
                        if cc < 0 || cc >= cols as isize {
                            continue;
                        }
                        let ci = rr as usize * cols + cc as usize;
                        let cen = &centers[ci];
                        let dc2 =
                            (pl - cen.l).powi(2) + (pa - cen.a).powi(2) + (pb - cen.b).powi(2);
                        let ds2 = (x - cen.x).powi(2) + (y - cen.y).powi(2);
                        let d = dc2 + ds2 * inv_s2;
                        if d < best {
                            best = d;
                            best_ci = ci as u32;
                        }
                    }
                }
                *out = best_ci;
            });

        // Recompute centers as the mean of their assigned pixels.
        let mut acc = vec![(0f64, 0f64, 0f64, 0f64, 0f64, 0u32); centers.len()];
        for (idx, &ci) in labels.iter().enumerate() {
            let (l, a, b) = lab[idx];
            let e = &mut acc[ci as usize];
            e.0 += l as f64;
            e.1 += a as f64;
            e.2 += b as f64;
            e.3 += (idx % width) as f64;
            e.4 += (idx / width) as f64;
            e.5 += 1;
        }
        for (c, e) in centers.iter_mut().zip(acc.iter()) {
            if e.5 == 0 {
                continue;
            }
            let cnt = e.5 as f64;
            c.l = (e.0 / cnt) as f32;
            c.a = (e.1 / cnt) as f32;
            c.b = (e.2 / cnt) as f32;
            c.x = (e.3 / cnt) as f32;
            c.y = (e.4 / cnt) as f32;
        }
    }

    enforce_connectivity(&labels, width, height, k)
}

/// Merge orphaned/undersized segments so every superpixel is 4-connected, and
/// relabel the result contiguously from 0. Small segments (below a fraction of
/// the nominal superpixel area) are absorbed into an adjacent labeled segment.
fn enforce_connectivity(
    old_labels: &[u32],
    width: usize,
    height: usize,
    target_count: usize,
) -> (Array2<u32>, usize) {
    let n = width * height;
    let min_size = ((n / target_count.max(1)) / 4).max(1);
    let mut new_labels = vec![-1i32; n];
    let mut label = 0i32;
    let mut buffer: Vec<usize> = Vec::with_capacity(64);

    const DX: [i32; 4] = [-1, 1, 0, 0];
    const DY: [i32; 4] = [0, 0, -1, 1];

    for start in 0..n {
        if new_labels[start] != -1 {
            continue;
        }

        // Find an already-labeled adjacent segment to merge into if this one
        // turns out to be too small.
        let mut adjacent = label.max(0);
        {
            let x = (start % width) as i32;
            let y = (start / width) as i32;
            for k in 0..4 {
                let nx = x + DX[k];
                let ny = y + DY[k];
                if nx >= 0 && nx < width as i32 && ny >= 0 && ny < height as i32 {
                    let ni = ny as usize * width + nx as usize;
                    if new_labels[ni] >= 0 {
                        adjacent = new_labels[ni];
                    }
                }
            }
        }

        // Flood-fill the contiguous region sharing this old label.
        buffer.clear();
        buffer.push(start);
        new_labels[start] = label;
        let mut head = 0;
        while head < buffer.len() {
            let idx = buffer[head];
            head += 1;
            let x = (idx % width) as i32;
            let y = (idx / width) as i32;
            for k in 0..4 {
                let nx = x + DX[k];
                let ny = y + DY[k];
                if nx >= 0 && nx < width as i32 && ny >= 0 && ny < height as i32 {
                    let ni = ny as usize * width + nx as usize;
                    if new_labels[ni] == -1 && old_labels[ni] == old_labels[idx] {
                        new_labels[ni] = label;
                        buffer.push(ni);
                    }
                }
            }
        }

        if buffer.len() <= min_size {
            // Absorb the tiny segment into its neighbor; reuse this label id.
            for &idx in &buffer {
                new_labels[idx] = adjacent;
            }
        } else {
            label += 1;
        }
    }

    let num = (label.max(1)) as usize;
    let labels =
        Array2::from_shape_fn((height, width), |(y, x)| new_labels[y * width + x].max(0) as u32);
    (labels, num)
}

/// Build the 4-connected superpixel adjacency graph from the label map.
fn build_adjacency(
    labels: &Array2<u32>,
    num_superpixels: usize,
    width: usize,
    height: usize,
) -> Vec<Vec<u32>> {
    let mut adjacency: Vec<Vec<u32>> = vec![Vec::new(); num_superpixels];
    for y in 0..height {
        for x in 0..width {
            let id = labels[[y, x]];
            if x + 1 < width {
                let r = labels[[y, x + 1]];
                if r != id {
                    adjacency[id as usize].push(r);
                    adjacency[r as usize].push(id);
                }
            }
            if y + 1 < height {
                let d = labels[[y + 1, x]];
                if d != id {
                    adjacency[id as usize].push(d);
                    adjacency[d as usize].push(id);
                }
            }
        }
    }
    for neighbors in adjacency.iter_mut() {
        neighbors.sort_unstable();
        neighbors.dedup();
    }
    adjacency
}
