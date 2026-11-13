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

#[cfg(test)]
mod tests {
    use super::*;

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
