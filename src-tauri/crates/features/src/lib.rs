//! The per-pixel arithmetic behind Didascalie's feature stack: the local
//! filter bank, and the copy that concatenates it with the other channels.
//!
//! A crate of its own so that it is optimised in a dev build, where the
//! application crate is not: unoptimised, these loops were most of the time a
//! training run spent before its first epoch. It holds no application logic
//! and builds in seconds.

pub mod filters;

use ndarray::{Array3, Axis};

/// Concatenate `[c, h, w]` volumes along their channels, in order.
pub fn stack(parts: &[&Array3<f32>], h: usize, w: usize) -> Array3<f32> {
    let d: usize = parts.iter().map(|p| p.shape()[0]).sum();
    let mut out = Array3::<f32>::zeros((d, h, w));
    let mut o = 0;
    for p in parts {
        for c in 0..p.shape()[0] {
            out.index_axis_mut(Axis(0), o)
                .assign(&p.index_axis(Axis(0), c));
            o += 1;
        }
    }
    out
}

/// `[k, h, w]` planes, plane `k` filled with `bias[k]`: where a 1x1
/// convolution's output starts.
pub fn bias_planes(bias: &[f32], h: usize, w: usize) -> Array3<f32> {
    Array3::from_shape_fn((bias.len(), h, w), |(k, _, _)| bias[k])
}

/// Add to `out` what channels `offset..offset + c` of a 1x1 convolution's
/// input contribute: `out[k] += Σ_j weights[k * d_in + offset + j] * x[j]`,
/// for `x` of shape `[c, h, w]` and `out` of `[k, h, w]`. `weights` is the
/// layer's `[k, d_in]` matrix, row-major.
pub fn project_into(out: &mut Array3<f32>, x: &Array3<f32>, weights: &[f32], d_in: usize, offset: usize) {
    use rayon::prelude::*;

    let (c, h, w) = (x.shape()[0], x.shape()[1], x.shape()[2]);
    let n = h * w;
    assert_eq!((out.shape()[1], out.shape()[2]), (h, w), "planes of different sizes");
    assert!(offset + c <= d_in && weights.len() == out.shape()[0] * d_in, "weights do not fit");
    if n == 0 || c == 0 {
        return;
    }
    let x = x.as_standard_layout();
    let x = x.as_slice().expect("standard layout is contiguous");
    let out = out.as_slice_mut().expect("the output must be contiguous");
    out.par_chunks_mut(n).enumerate().for_each(|(k, plane)| {
        let row = &weights[k * d_in + offset..k * d_in + offset + c];
        for (j, &wt) in row.iter().enumerate() {
            let src = &x[j * n..(j + 1) * n];
            for (o, &v) in plane.iter_mut().zip(src) {
                *o += wt * v;
            }
        }
    });
}

/// `out += other`, element by element.
pub fn add_into(out: &mut Array3<f32>, other: &Array3<f32>) {
    assert_eq!(out.shape(), other.shape(), "volumes of different shapes");
    ndarray::Zip::from(out).and(other).for_each(|o, &v| *o += v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_is_a_weighted_sum_of_the_named_channels() {
        // Two outputs over a four-channel layer; `x` supplies channels 1 and 2.
        let weights = [1.0, 2.0, 3.0, 4.0, /* */ 0.5, 0.0, -1.0, 9.0];
        let x = Array3::from_shape_fn((2, 1, 3), |(c, _, i)| (c * 10 + i) as f32);
        let mut out = bias_planes(&[100.0, 200.0], 1, 3);
        project_into(&mut out, &x, &weights, 4, 1);
        for i in 0..3 {
            let (a, b) = (i as f32, 10.0 + i as f32);
            assert_eq!(out[[0, 0, i]], 100.0 + 2.0 * a + 3.0 * b);
            assert_eq!(out[[1, 0, i]], 200.0 - b);
        }
        add_into(&mut out, &Array3::from_elem((2, 1, 3), 1.0));
        assert_eq!(out[[1, 0, 0]], 191.0);
    }

    #[test]
    fn stack_keeps_the_channel_order() {
        let a = Array3::from_elem((2, 3, 4), 1.0f32);
        let b = Array3::from_elem((1, 3, 4), 2.0f32);
        let out = stack(&[&a, &b], 3, 4);
        assert_eq!(out.shape(), &[3, 3, 4]);
        assert!(out.index_axis(Axis(0), 1).iter().all(|&v| v == 1.0));
        assert!(out.index_axis(Axis(0), 2).iter().all(|&v| v == 2.0));
    }

    /// Not a check: prints what one tile's local features and stack cost.
    /// `cargo test -p didascalie-features time_one_tile -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn time_one_tile() {
        let image = Array3::from_shape_fn((3, 384, 384), |(c, y, x)| ((c + y * 7 + x * 3) % 97) as f32 / 97.0);
        let encoder = Array3::<f32>::zeros((384, 384, 384));
        let t = std::time::Instant::now();
        let (local, _) = filters::compute(&image, &filters::FilterBankConfig::default());
        let filters_ms = t.elapsed().as_millis();
        let t = std::time::Instant::now();
        let out = stack(&[&local, &encoder], 384, 384);
        println!("filters {filters_ms} ms, stack {} ms, {} channels", t.elapsed().as_millis(), out.shape()[0]);
    }
}
