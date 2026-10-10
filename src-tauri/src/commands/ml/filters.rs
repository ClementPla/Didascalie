//! A local feature basis at full working resolution.
//!
//! ViT encoders emit one token per patch, so structures thinner than a patch
//! are smeared; this bank fills that gap. It is a generic differential basis,
//! not a set of tuned detectors: Hessian eigenvalues stay signed and ordered by
//! magnitude, so bright and dark tubes, blobs and edges remain distinguishable
//! and the head decides what matters. Images are robustly normalised first;
//! the multi-scale stack is computed on luminance, with raw channels passed
//! through.

use ndarray::{Array2, Array3};
use rayon::prelude::*;

/// Gaussian sigmas, in pixels, of the differential features.
pub const DEFAULT_SCALES: [f32; 4] = [1.0, 2.0, 4.0, 8.0];

const PER_SCALE: usize = 6;

#[derive(Debug, Clone)]
pub struct FilterBankConfig {
    pub scales: Vec<f32>,
}

impl Default for FilterBankConfig {
    fn default() -> Self {
        Self {
            scales: DEFAULT_SCALES.to_vec(),
        }
    }
}

impl FilterBankConfig {
    pub fn output_channels(&self, in_channels: usize) -> usize {
        in_channels + self.scales.len() * PER_SCALE
    }
}

/// Mirror an index back into `[0, n)`.
fn reflect(mut i: isize, n: usize) -> usize {
    let n_i = n as isize;
    if n_i == 1 {
        return 0;
    }
    loop {
        if i < 0 {
            i = -i - 1;
        } else if i >= n_i {
            i = 2 * n_i - i - 1;
        } else {
            return i as usize;
        }
    }
}

/// Normalised 1-D Gaussian kernel, truncated at 3 sigma.
fn gaussian_kernel(sigma: f32) -> Vec<f32> {
    let radius = (3.0 * sigma).ceil().max(1.0) as isize;
    let two_sig_sq = 2.0 * sigma * sigma;
    let mut k: Vec<f32> = (-radius..=radius)
        .map(|x| (-(x * x) as f32 / two_sig_sq).exp())
        .collect();
    let sum: f32 = k.iter().sum();
    for v in &mut k {
        *v /= sum;
    }
    k
}

/// Separable Gaussian blur with reflected borders.
pub fn gaussian_blur(src: &Array2<f32>, sigma: f32) -> Array2<f32> {
    let (h, w) = (src.shape()[0], src.shape()[1]);
    let k = gaussian_kernel(sigma);
    let r = (k.len() / 2) as isize;

    let mut tmp = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (t, &kv) in k.iter().enumerate() {
                let xx = reflect(x as isize + t as isize - r, w);
                acc += kv * src[[y, xx]];
            }
            tmp[[y, x]] = acc;
        }
    }

    let mut out = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let mut acc = 0.0;
            for (t, &kv) in k.iter().enumerate() {
                let yy = reflect(y as isize + t as isize - r, h);
                acc += kv * tmp[[yy, x]];
            }
            out[[y, x]] = acc;
        }
    }
    out
}

pub fn gradient_magnitude(src: &Array2<f32>) -> Array2<f32> {
    let (h, w) = (src.shape()[0], src.shape()[1]);
    let mut out = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let xm = reflect(x as isize - 1, w);
            let xp = reflect(x as isize + 1, w);
            let ym = reflect(y as isize - 1, h);
            let yp = reflect(y as isize + 1, h);
            let gx = 0.5 * (src[[y, xp]] - src[[y, xm]]);
            let gy = 0.5 * (src[[yp, x]] - src[[ym, x]]);
            out[[y, x]] = (gx * gx + gy * gy).sqrt();
        }
    }
    out
}

/// Second derivatives `(Lxx, Lyy, Lxy)`, scaled by `sigma^2` to be comparable
/// across scales.
fn hessian_components(src: &Array2<f32>, sigma: f32) -> (Array2<f32>, Array2<f32>, Array2<f32>) {
    let (h, w) = (src.shape()[0], src.shape()[1]);
    let norm = sigma * sigma;
    let mut lxx = Array2::<f32>::zeros((h, w));
    let mut lyy = Array2::<f32>::zeros((h, w));
    let mut lxy = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let xm = reflect(x as isize - 1, w);
            let xp = reflect(x as isize + 1, w);
            let ym = reflect(y as isize - 1, h);
            let yp = reflect(y as isize + 1, h);
            let c = src[[y, x]];
            lxx[[y, x]] = norm * (src[[y, xp]] - 2.0 * c + src[[y, xm]]);
            lyy[[y, x]] = norm * (src[[yp, x]] - 2.0 * c + src[[ym, x]]);
            lxy[[y, x]] = norm * 0.25
                * (src[[yp, xp]] - src[[yp, xm]] - src[[ym, xp]] + src[[ym, xm]]);
        }
    }
    (lxx, lyy, lxy)
}

/// Signed Hessian eigenvalues, ordered so that `|l1| <= |l2|`. The sign says
/// whether a structure is brighter or darker than its surround.
pub fn hessian_eigenvalues(src: &Array2<f32>, sigma: f32) -> (Array2<f32>, Array2<f32>) {
    let (h, w) = (src.shape()[0], src.shape()[1]);
    let (lxx, lyy, lxy) = hessian_components(src, sigma);
    let mut e1 = Array2::<f32>::zeros((h, w));
    let mut e2 = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let a = lxx[[y, x]];
            let d = lyy[[y, x]];
            let b = lxy[[y, x]];
            let half_tr = 0.5 * (a + d);
            let disc = (0.25 * (a - d) * (a - d) + b * b).max(0.0).sqrt();
            let (mut l1, mut l2) = (half_tr + disc, half_tr - disc);
            if l1.abs() > l2.abs() {
                std::mem::swap(&mut l1, &mut l2);
            }
            e1[[y, x]] = l1;
            e2[[y, x]] = l2;
        }
    }
    (e1, e2)
}

/// Local standard deviation over a Gaussian window: a texture cue.
pub fn local_std(src: &Array2<f32>, sigma: f32) -> Array2<f32> {
    let mean = gaussian_blur(src, sigma);
    let sq = src.mapv(|v| v * v);
    let mean_sq = gaussian_blur(&sq, sigma);
    let (h, w) = (src.shape()[0], src.shape()[1]);
    let mut out = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            let var = (mean_sq[[y, x]] - mean[[y, x]] * mean[[y, x]]).max(0.0);
            out[[y, x]] = var.sqrt();
        }
    }
    out
}

/// Rescale to `[0, 1]` between the 1st and 99th percentiles.
pub fn robust_normalize(src: &Array2<f32>) -> Array2<f32> {
    let mut vals: Vec<f32> = src.iter().copied().filter(|v| v.is_finite()).collect();
    if vals.is_empty() {
        return src.clone();
    }
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let lo = vals[((vals.len() as f32 * 0.01) as usize).min(vals.len() - 1)];
    let hi = vals[((vals.len() as f32 * 0.99) as usize).min(vals.len() - 1)];
    let range = hi - lo;
    if range.abs() < f32::EPSILON {
        return Array2::zeros(src.raw_dim());
    }
    src.mapv(|v| ((v - lo) / range).clamp(0.0, 1.0))
}

/// Luminance of a `[C, H, W]` image (`C` of 1 or 3; other counts average).
fn luminance(image: &Array3<f32>) -> Array2<f32> {
    let (c, h, w) = (image.shape()[0], image.shape()[1], image.shape()[2]);
    let mut out = Array2::<f32>::zeros((h, w));
    for y in 0..h {
        for x in 0..w {
            out[[y, x]] = match c {
                1 => image[[0, y, x]],
                3 => {
                    0.299 * image[[0, y, x]] + 0.587 * image[[1, y, x]] + 0.114 * image[[2, y, x]]
                }
                n => (0..n).map(|ch| image[[ch, y, x]]).sum::<f32>() / n as f32,
            };
        }
    }
    out
}

/// The full basis of a `[C, H, W]` image: `([D, H, W], channel_names)`. The
/// names are stored with a trained head.
pub fn compute(image: &Array3<f32>, cfg: &FilterBankConfig) -> (Array3<f32>, Vec<String>) {
    let (c, h, w) = (image.shape()[0], image.shape()[1], image.shape()[2]);
    let d = cfg.output_channels(c);
    let mut out = Array3::<f32>::zeros((d, h, w));
    let mut names = Vec::with_capacity(d);

    for ch in 0..c {
        let plane = robust_normalize(&image.index_axis(ndarray::Axis(0), ch).to_owned());
        out.index_axis_mut(ndarray::Axis(0), ch).assign(&plane);
        names.push(format!("raw/c{ch}"));
    }

    let gray = robust_normalize(&luminance(image));

    // Scales run in parallel, and only they do: nesting rayon in the convolutions
    // would oversubscribe the pool. `collect()` keeps the channel order.
    let per_scale: Vec<[(Array2<f32>, &'static str); PER_SCALE]> = cfg
        .scales
        .par_iter()
        .map(|&sigma| {
            let smoothed = gaussian_blur(&gray, sigma);
            let grad = gradient_magnitude(&smoothed);
            // Laplacian = trace of the Hessian.
            let (lxx, lyy, _) = hessian_components(&smoothed, sigma);
            let log = &lxx + &lyy;
            let (e1, e2) = hessian_eigenvalues(&smoothed, sigma);
            let std = local_std(&gray, sigma);
            [
                (smoothed, "gauss"),
                (grad, "grad"),
                (log, "log"),
                (e1, "hess1"),
                (e2, "hess2"),
                (std, "std"),
            ]
        })
        .collect();

    let mut idx = c;
    for (&sigma, planes) in cfg.scales.iter().zip(per_scale) {
        for (plane, tag) in planes {
            out.index_axis_mut(ndarray::Axis(0), idx).assign(&plane);
            names.push(format!("s{sigma}/{tag}"));
            idx += 1;
        }
    }

    debug_assert_eq!(idx, d);
    (out, names)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn constant(h: usize, w: usize, v: f32) -> Array2<f32> {
        Array2::from_elem((h, w), v)
    }

    #[test]
    fn reflect_mirrors_at_both_edges() {
        assert_eq!(reflect(-1, 5), 0);
        assert_eq!(reflect(-2, 5), 1);
        assert_eq!(reflect(5, 5), 4);
        assert_eq!(reflect(6, 5), 3);
        assert_eq!(reflect(2, 5), 2);
        assert_eq!(reflect(-3, 1), 0);
    }

    #[test]
    fn gaussian_preserves_constant_and_kernel_sums_to_one() {
        let k = gaussian_kernel(2.0);
        assert!((k.iter().sum::<f32>() - 1.0).abs() < 1e-5);
        let img = constant(12, 12, 0.42);
        let blurred = gaussian_blur(&img, 2.0);
        for v in blurred.iter() {
            assert!((v - 0.42).abs() < 1e-4, "got {v}");
        }
    }

    #[test]
    fn derivatives_vanish_on_constant_images() {
        let img = constant(10, 10, 0.7);
        assert!(gradient_magnitude(&img).iter().all(|v| v.abs() < 1e-5));
        assert!(local_std(&img, 2.0).iter().all(|v| v.abs() < 1e-4));
        let (e1, e2) = hessian_eigenvalues(&img, 1.0);
        assert!(e1.iter().all(|v| v.abs() < 1e-5));
        assert!(e2.iter().all(|v| v.abs() < 1e-5));
    }

    #[test]
    fn hessian_sign_distinguishes_bright_from_dark_structures() {
        // A bright line and its inverse: the large eigenvalue must flip sign.
        let (h, w) = (21, 21);
        let mut bright = Array2::<f32>::zeros((h, w));
        for x in 0..w {
            bright[[10, x]] = 1.0;
        }
        let dark = bright.mapv(|v| 1.0 - v);

        let sb = gaussian_blur(&bright, 1.0);
        let sd = gaussian_blur(&dark, 1.0);
        let (_, e2b) = hessian_eigenvalues(&sb, 1.0);
        let (_, e2d) = hessian_eigenvalues(&sd, 1.0);

        assert!(e2b[[10, 10]] < 0.0, "bright ridge: {}", e2b[[10, 10]]);
        assert!(e2d[[10, 10]] > 0.0, "dark ridge: {}", e2d[[10, 10]]);
    }

    #[test]
    fn robust_normalize_handles_arbitrary_ranges_and_flat_images() {
        let img = Array2::from_shape_fn((10, 10), |(y, x)| -1000.0 + (y * 10 + x) as f32 * 20.0);
        let n = robust_normalize(&img);
        assert!(n.iter().all(|&v| (0.0..=1.0).contains(&v)));
        assert!(n.iter().cloned().fold(f32::MIN, f32::max) > 0.9);

        // A flat image must not divide by zero.
        let flat = constant(5, 5, 3.0);
        assert!(robust_normalize(&flat).iter().all(|v| v.abs() < 1e-6));
    }

    #[test]
    fn compute_shapes_match_for_gray_and_colour() {
        let cfg = FilterBankConfig::default();

        let gray = Array3::from_shape_fn((1, 16, 16), |(_, y, x)| ((y + x) % 5) as f32);
        let (feat, names) = compute(&gray, &cfg);
        assert_eq!(feat.shape()[0], cfg.output_channels(1));
        assert_eq!(feat.shape()[0], 1 + 4 * PER_SCALE);
        assert_eq!(names.len(), feat.shape()[0]);
        assert_eq!(feat.shape()[1..], [16, 16]);

        let rgb = Array3::from_shape_fn((3, 16, 16), |(c, y, x)| ((y + x + c) % 7) as f32);
        let (feat, names) = compute(&rgb, &cfg);
        assert_eq!(feat.shape()[0], cfg.output_channels(3));
        assert_eq!(names.len(), feat.shape()[0]);
        assert!(feat.iter().all(|v| v.is_finite()));
        let mut sorted = names.clone();
        sorted.sort();
        let before = sorted.len();
        sorted.dedup();
        assert_eq!(before, sorted.len());
    }
}
