//! Cleaning up a binary selection, for the stroke-bounded operators (Otsu,
//! flood fill).

use ndarray::Array2;
use std::collections::VecDeque;

/// What to do to a selection, in this order.
#[derive(Debug, Clone, Copy, Default)]
pub struct Refine {
    pub fill_holes: bool,
    /// Standard deviation, in pixels, of the outline smoothing. 0 leaves the
    /// outline as it is.
    pub smooth: f32,
    /// Keep the largest connected region only.
    pub largest_only: bool,
}

pub fn refine(mask: &Array2<bool>, options: &Refine) -> Array2<bool> {
    let mut out = mask.clone();
    if options.fill_holes {
        out = fill_holes(&out);
    }
    if options.smooth > 0.0 {
        out = smooth_mask(&out, options.smooth);
    }
    if options.largest_only {
        out = largest_component(&out);
    }
    out
}

/// Below this, a blur changes nothing once thresholded.
const MIN_SIGMA: f32 = 0.3;
/// Above this, three box blurs stand in for the Gaussian kernel.
const EXACT_SIGMA: f32 = 4.0;
/// Largest blur applied (px); the UI offers far less.
const MAX_SIGMA: f32 = 64.0;

/// Round the outline of a selection: blur it, and keep what is still above
/// one half. Bumps and notches narrower than about `sigma` go, a straight edge
/// stays where it is, and separate regions are not joined.
pub fn smooth_mask(mask: &Array2<bool>, sigma: f32) -> Array2<bool> {
    if sigma.is_nan() || sigma < MIN_SIGMA {
        return mask.clone();
    }
    let soft = blur(&mask.map(|&on| if on { 1.0 } else { 0.0 }), sigma);
    soft.map(|&v| v > 0.5)
}

/// Blur an 8-bit image, to threshold it without its pixel noise.
/// [`denoise`] for float intensities.
pub fn denoise_f32(image: &Array2<f32>, sigma: f32) -> Array2<f32> {
    if sigma.is_nan() || sigma < MIN_SIGMA {
        return image.clone();
    }
    blur(image, sigma)
}

/// A selection as a single-channel presence mask (255 = selected), row-major:
/// what the operators send back.
pub fn presence_bytes(mask: &Array2<bool>) -> Vec<u8> {
    mask.iter().map(|&on| if on { 255u8 } else { 0 }).collect()
}

pub fn denoise(image: &Array2<u8>, sigma: f32) -> Array2<u8> {
    if sigma.is_nan() || sigma < MIN_SIGMA {
        return image.clone();
    }
    blur(&image.map(|&v| v as f32), sigma).map(|&v| v.round().clamp(0.0, 255.0) as u8)
}

/// Gaussian blur. Pixels past the border take the border's value, so a region
/// touching the edge of the array is not eaten away.
pub fn blur(src: &Array2<f32>, sigma: f32) -> Array2<f32> {
    // Sigma comes over IPC; past this the box blur's cost explodes for no
    // visible difference.
    let sigma = sigma.min(MAX_SIGMA);
    if sigma <= EXACT_SIGMA {
        let kernel = gaussian_kernel(sigma);
        return filter_columns(&filter_rows(src, &kernel), &kernel);
    }
    // Three box blurs of width w have variance 3 (w² - 1) / 12.
    let width = (4.0 * sigma * sigma + 1.0).sqrt();
    let radius = ((width - 1.0) / 2.0).round().max(1.0) as usize;
    let mut out = src.clone();
    for _ in 0..3 {
        out = box_columns(&box_rows(&out, radius), radius);
    }
    out
}

fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as isize;
    let mut kernel: Vec<f32> = (-radius..=radius)
        .map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp())
        .collect();
    let sum: f32 = kernel.iter().sum();
    kernel.iter_mut().for_each(|k| *k /= sum);
    kernel
}

fn clamp_index(i: isize, n: usize) -> usize {
    i.clamp(0, n as isize - 1) as usize
}

fn filter_rows(src: &Array2<f32>, kernel: &[f32]) -> Array2<f32> {
    filter_axis(src, kernel, false)
}

fn filter_columns(src: &Array2<f32>, kernel: &[f32]) -> Array2<f32> {
    filter_axis(src, kernel, true)
}

/// Convolve along x (`vertical: false`) or y, clamping at the edges.
fn filter_axis(src: &Array2<f32>, kernel: &[f32], vertical: bool) -> Array2<f32> {
    let (h, w) = src.dim();
    let radius = (kernel.len() / 2) as isize;
    Array2::from_shape_fn((h, w), |(y, x)| {
        kernel
            .iter()
            .enumerate()
            .map(|(k, weight)| {
                let offset = k as isize - radius;
                let sample = if vertical {
                    src[[clamp_index(y as isize + offset, h), x]]
                } else {
                    src[[y, clamp_index(x as isize + offset, w)]]
                };
                weight * sample
            })
            .sum()
    })
}

/// Mean over `2 * radius + 1` values along one line, by a running sum.
fn box_line(line: &[f32], radius: usize, out: &mut [f32]) {
    let n = line.len();
    let r = radius as isize;
    let width = (2 * radius + 1) as f32;
    let at = |i: isize| line[clamp_index(i, n)];
    let mut sum: f32 = (-r..=r).map(at).sum();
    for i in 0..n {
        out[i] = sum / width;
        sum += at(i as isize + r + 1) - at(i as isize - r);
    }
}

fn box_rows(src: &Array2<f32>, radius: usize) -> Array2<f32> {
    let (h, w) = src.dim();
    let mut out = Array2::<f32>::zeros((h, w));
    let mut line = vec![0.0; w];
    let mut blurred = vec![0.0; w];
    for y in 0..h {
        for x in 0..w {
            line[x] = src[[y, x]];
        }
        box_line(&line, radius, &mut blurred);
        for x in 0..w {
            out[[y, x]] = blurred[x];
        }
    }
    out
}

fn box_columns(src: &Array2<f32>, radius: usize) -> Array2<f32> {
    let (h, w) = src.dim();
    let mut out = Array2::<f32>::zeros((h, w));
    let mut line = vec![0.0; h];
    let mut blurred = vec![0.0; h];
    for x in 0..w {
        for y in 0..h {
            line[y] = src[[y, x]];
        }
        box_line(&line, radius, &mut blurred);
        for y in 0..h {
            out[[y, x]] = blurred[y];
        }
    }
    out
}

/// Fill the holes of a selection: the background that cannot be reached from
/// the border of the array without crossing the selection.
pub fn fill_holes(mask: &Array2<bool>) -> Array2<bool> {
    let (h, w) = mask.dim();
    if h == 0 || w == 0 {
        return mask.clone();
    }
    let mut outside = Array2::from_elem((h, w), false);
    let mut queue = VecDeque::new();
    let visit =
        |y: usize, x: usize, outside: &mut Array2<bool>, queue: &mut VecDeque<(usize, usize)>| {
            if !mask[[y, x]] && !outside[[y, x]] {
                outside[[y, x]] = true;
                queue.push_back((y, x));
            }
        };
    for x in 0..w {
        visit(0, x, &mut outside, &mut queue);
        visit(h - 1, x, &mut outside, &mut queue);
    }
    for y in 0..h {
        visit(y, 0, &mut outside, &mut queue);
        visit(y, w - 1, &mut outside, &mut queue);
    }
    while let Some((y, x)) = queue.pop_front() {
        if y > 0 {
            visit(y - 1, x, &mut outside, &mut queue);
        }
        if y + 1 < h {
            visit(y + 1, x, &mut outside, &mut queue);
        }
        if x > 0 {
            visit(y, x - 1, &mut outside, &mut queue);
        }
        if x + 1 < w {
            visit(y, x + 1, &mut outside, &mut queue);
        }
    }
    outside.map(|&is_outside| !is_outside)
}

/// The largest 8-connected region of a selection.
pub fn largest_component(mask: &Array2<bool>) -> Array2<bool> {
    let (h, w) = mask.dim();
    let mut labels = Array2::<u32>::zeros((h, w));
    let mut sizes = vec![0usize];
    let mut queue = VecDeque::new();
    for sy in 0..h {
        for sx in 0..w {
            if !mask[[sy, sx]] || labels[[sy, sx]] != 0 {
                continue;
            }
            let label = sizes.len() as u32;
            let mut size = 0;
            labels[[sy, sx]] = label;
            queue.push_back((sy, sx));
            while let Some((y, x)) = queue.pop_front() {
                size += 1;
                for ny in y.saturating_sub(1)..=(y + 1).min(h - 1) {
                    for nx in x.saturating_sub(1)..=(x + 1).min(w - 1) {
                        if mask[[ny, nx]] && labels[[ny, nx]] == 0 {
                            labels[[ny, nx]] = label;
                            queue.push_back((ny, nx));
                        }
                    }
                }
            }
            sizes.push(size);
        }
    }
    let largest = (1..sizes.len()).max_by_key(|&l| sizes[l]).unwrap_or(0) as u32;
    labels.map(|&l| l != 0 && l == largest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(h: usize, w: usize, y0: usize, y1: usize, x0: usize, x1: usize) -> Array2<bool> {
        Array2::from_shape_fn((h, w), |(y, x)| y >= y0 && y < y1 && x >= x0 && x < x1)
    }

    fn count(mask: &Array2<bool>) -> usize {
        mask.iter().filter(|&&on| on).count()
    }

    #[test]
    fn smoothing_keeps_a_straight_edge_in_place() {
        // The left half of the array, with the exact kernel and the box one.
        let half = rect(40, 40, 0, 40, 0, 20);
        assert_eq!(smooth_mask(&half, 2.0), half);
        assert_eq!(smooth_mask(&half, 6.0), half);
    }

    #[test]
    fn smoothing_removes_a_bump_and_fills_a_notch() {
        let mut shape = rect(40, 40, 10, 30, 10, 30);
        let plain = shape.clone();
        shape[[9, 20]] = true; // a bump on the top edge
        shape[[10, 15]] = false; // a notch in it
        assert_eq!(smooth_mask(&shape, 1.0), smooth_mask(&plain, 1.0));
    }

    #[test]
    fn smoothing_does_not_join_separate_regions() {
        // Two squares 6 px apart, which a closing of radius 3 would fuse.
        let mut shape = rect(30, 50, 8, 22, 5, 20);
        shape.zip_mut_with(&rect(30, 50, 8, 22, 26, 41), |a, &b| *a |= b);
        let smooth = smooth_mask(&shape, 2.0);
        for y in 0..30 {
            assert!(!smooth[[y, 23]], "bridged at row {y}");
        }
        assert!(smooth[[15, 12]] && smooth[[15, 33]]);
    }

    #[test]
    fn smoothing_does_not_erode_at_the_border() {
        // A selection covering the whole array has nothing to round.
        let full = Array2::from_elem((12, 12), true);
        assert_eq!(count(&smooth_mask(&full, 3.0)), 144);
        assert_eq!(count(&smooth_mask(&full, 8.0)), 144);
    }

    #[test]
    fn smoothing_removes_what_is_much_thinner_than_sigma() {
        let line = rect(30, 30, 15, 16, 0, 30);
        assert_eq!(count(&smooth_mask(&line, 2.0)), 0);
        // … and leaves it alone when turned off.
        assert_eq!(smooth_mask(&line, 0.0), line);
    }

    #[test]
    fn box_blur_matches_the_kernel_at_the_switch() {
        // The two implementations must agree where one takes over.
        let shape = rect(60, 60, 20, 40, 15, 45).map(|&on| if on { 1.0 } else { 0.0 });
        let exact = filter_columns(
            &filter_rows(&shape, &gaussian_kernel(4.5)),
            &gaussian_kernel(4.5),
        );
        let boxed = blur(&shape, 4.5);
        let worst = exact
            .iter()
            .zip(boxed.iter())
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(worst < 0.06, "differs by {worst}");
    }

    #[test]
    fn holes_are_filled_and_bays_are_not() {
        let mut ring = rect(20, 20, 4, 16, 4, 16);
        for y in 8..12 {
            for x in 8..12 {
                ring[[y, x]] = false; // enclosed
            }
        }
        let filled = fill_holes(&ring);
        assert_eq!(filled, rect(20, 20, 4, 16, 4, 16));

        // Open the hole to the outside: it is a bay, and stays.
        let mut bay = ring.clone();
        for y in 4..8 {
            bay[[y, 9]] = false;
        }
        assert_eq!(fill_holes(&bay), bay);
    }

    #[test]
    fn a_hole_against_the_border_is_not_filled() {
        // Background touching the edge of the array is outside.
        let mut shape = Array2::from_elem((10, 10), true);
        shape[[0, 4]] = false;
        shape[[1, 4]] = false;
        assert_eq!(fill_holes(&shape), shape);
    }

    #[test]
    fn largest_component_drops_the_others() {
        let mut shape = rect(20, 20, 2, 10, 2, 10);
        shape[[15, 15]] = true;
        shape[[16, 16]] = true; // joined to the previous one by a corner
        assert_eq!(largest_component(&shape), rect(20, 20, 2, 10, 2, 10));
        assert_eq!(
            count(&largest_component(&Array2::from_elem((4, 4), false))),
            0
        );
    }

    #[test]
    fn denoising_removes_salt_and_pepper_before_a_threshold() {
        // Dark left half, bright right half, one wrong pixel in each.
        let mut image = Array2::from_shape_fn((20, 20), |(_, x)| if x < 10 { 40u8 } else { 200 });
        image[[5, 3]] = 255;
        image[[12, 16]] = 0;
        let clean = denoise(&image, 1.5).map(|&v| v > 120);
        assert_eq!(clean, rect(20, 20, 0, 20, 10, 20));
        assert_eq!(denoise(&image, 0.0), image);
    }

    #[test]
    fn refine_applies_the_steps_in_order() {
        // A square with a hole and a speck beside it.
        let mut shape = rect(30, 30, 5, 25, 5, 25);
        shape[[15, 15]] = false;
        shape[[2, 2]] = true;
        let out = refine(
            &shape,
            &Refine {
                fill_holes: true,
                smooth: 0.0,
                largest_only: true,
            },
        );
        assert_eq!(out, rect(30, 30, 5, 25, 5, 25));
        assert_eq!(refine(&shape, &Refine::default()), shape);
    }
}
