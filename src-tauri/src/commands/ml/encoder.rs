//! Frozen ONNX encoder inference: image in, dense patch tokens out.
//!
//! # Robustness over hard-coding
//!
//! Every backbone names its tensors differently (`pixel_values` /
//! `last_hidden_state` for Hub ViTs, `image` / `features` for the bundled
//! SAM-style encoder) and lays its output out differently (`[B, T, D]` tokens
//! vs `[B, D, gh, gw]` maps). Rather than encode a table of per-model quirks,
//! this module:
//!
//! 1. takes the graph's *declared* input name, and
//! 2. binds every declared output, runs once, and picks the result that
//!    actually looks like a dense feature map.
//!
//! The registry's `embed_dim` / `input_size` stay hints for the UI; the numbers
//! used for real come from the graph. A new encoder can usually be added by
//! appending one catalog row.

use ndarray::{Array3, Array4};
use ort::{
    execution_providers::{
        CUDAExecutionProvider, CoreMLExecutionProvider, DirectMLExecutionProvider,
        ExecutionProvider,
    },
    session::{builder::GraphOptimizationLevel, Session},
    value::Tensor,
};
use std::path::Path;

/// The accelerator the encoder is *actually* running on.
///
/// Set by [`EncoderSession::load`] from the provider that genuinely registered,
/// not from what was merely offered. Defaults to CPU until an encoder loads.
static ACTIVE_ACCELERATOR: parking_lot::Mutex<&'static str> = parking_lot::Mutex::new("CPU");

/// Report the accelerator in use. See [`ACTIVE_ACCELERATOR`].
pub fn detect_accelerator() -> &'static str {
    *ACTIVE_ACCELERATOR.lock()
}

/// Attach the best available accelerator, returning which one took.
///
/// `is_available()` is **not** sufficient: it reports whether a provider was
/// compiled into `ort`, not whether it can load. A CUDA build whose machine
/// lacks `cudnn64_9.dll` answers "available" and then fails at registration —
/// and `with_execution_providers` logs that failure and silently continues on
/// CPU. Registering one at a time and checking the result is the only way to
/// know what is really executing, which is the difference between reporting
/// "CUDA" and reporting the truth.
fn attach_accelerator(
    builder: ort::session::builder::SessionBuilder,
) -> (ort::session::builder::SessionBuilder, &'static str) {
    macro_rules! try_ep {
        ($builder:expr, $ep:expr, $label:literal) => {{
            let mut b = $builder;
            let ep = $ep;
            match ep.is_available() {
                Ok(true) => match ep.register(&mut b) {
                    Ok(()) => return (b, $label),
                    Err(e) => {
                        log::warn!("[ml] {} present but failed to register: {e}", $label);
                    }
                },
                _ => {}
            }
            b
        }};
    }

    // TensorRT is deliberately not in the chain. It depends on CUDA *and*
    // cuDNN, so it cannot rescue a machine where the CUDA provider failed to
    // load; it additionally needs the TensorRT SDK, and builds engines on first
    // run, which would turn a missing cuDNN into a multi-minute stall rather
    // than a clear message.
    let builder = try_ep!(builder, CUDAExecutionProvider::default(), "CUDA (GPU)");
    let builder = try_ep!(builder, DirectMLExecutionProvider::default(), "DirectML (GPU)");
    let builder = try_ep!(builder, CoreMLExecutionProvider::default(), "CoreML");
    (builder, "CPU")
}

use super::registry::EncoderSpec;

/// A loaded, frozen encoder.
pub struct EncoderSession {
    session: Session,
    input_name: String,
    output_names: Vec<String>,
    /// Square input side the graph is fed (from the spec; graphs with dynamic
    /// axes accept it, fixed-axis graphs were authored for it).
    input_size: u32,
    spec: EncoderSpec,
    /// Kept so the session can be reopened on CPU if the accelerator turns out
    /// to be unable to execute this particular graph.
    path: std::path::PathBuf,
    cpu_only: bool,
}

/// Dense features from one image: `[D, grid_h, grid_w]`.
pub struct PatchFeatures {
    pub data: Array3<f32>,
}

impl EncoderSession {
    /// Open a cached `.onnx` file. Execution providers mirror `dl::model` so
    /// the GPU is used when present and CPU is the fallback.
    pub fn load(path: &Path, spec: EncoderSpec) -> Result<Self, String> {
        Self::open(path, spec, false)
    }

    /// As [`load`], but `force_cpu` skips accelerator registration entirely.
    ///
    /// Registering successfully is not the same as *executing* successfully:
    /// DirectML in particular accepts graphs with dynamic spatial axes and then
    /// fails inside a `Reshape` at run time. That is why this exists as a
    /// separate entry point rather than being folded into the provider chain.
    ///
    /// # Tried and rejected: pinning the symbolic dimensions
    ///
    /// ORT's own DirectML documentation prescribes
    /// `SessionBuilder::with_dimension_override` for graphs with dynamic inputs,
    /// and it looked like a clean fix here — this encoder only ever feeds
    /// `[1, 3, input_size, input_size]`, so the axes are dynamic in name only.
    /// It was implemented and **measured: it does not help.** Reopening with
    /// `s4`/`s99`/`s100` pinned to 512 fails in the same `Reshape`, so the
    /// defect is not shape inference. It only doubled the cost of the failure
    /// path (15.4s against 7.5s) before falling back anyway, so the machinery
    /// was removed. Do not re-add it without a graph that it demonstrably
    /// rescues.
    fn open(path: &Path, spec: EncoderSpec, force_cpu: bool) -> Result<Self, String> {
        let builder = Session::builder()
            .map_err(|e| format!("session builder: {e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("optimization level: {e}"))?
            .with_intra_threads(4)
            .map_err(|e| format!("intra threads: {e}"))?;

        let (builder, accel) = if force_cpu {
            (builder, "CPU")
        } else {
            attach_accelerator(builder)
        };
        *ACTIVE_ACCELERATOR.lock() = accel;
        if accel == "CPU" {
            log::info!(
                "[ml] encoder session — running on CPU. For NVIDIA acceleration \
                 ort needs cuDNN 9 (cudnn64_9.dll) on PATH alongside the CUDA \
                 runtime; without it the CUDA provider reports as available but \
                 fails to load."
            );
        } else {
            log::info!("[ml] encoder session — accelerator: {accel}");
        }

        let session = builder
            .commit_from_file(path)
            .map_err(|e| format!("failed to open {}: {e}", path.display()))?;

        let input_name = session
            .inputs
            .first()
            .map(|i| i.name.clone())
            .ok_or_else(|| "encoder graph declares no inputs".to_string())?;
        let output_names: Vec<String> = session.outputs.iter().map(|o| o.name.clone()).collect();
        if output_names.is_empty() {
            return Err("encoder graph declares no outputs".into());
        }

        let input_size = spec.input_size;
        Ok(Self {
            session,
            input_name,
            output_names,
            input_size,
            spec,
            path: path.to_path_buf(),
            cpu_only: force_cpu,
        })
    }

    /// Scale `[C, H, W]` in `[0, 1]` into the tensor the graph expects.
    ///
    /// Single-channel input (CT, MR, ultrasound, X-ray) is replicated across
    /// RGB, since these backbones are all three-channel.
    fn preprocess(&self, image: &Array3<f32>) -> Result<Tensor<f32>, String> {
        let s = self.input_size as usize;
        let resized = resize_bilinear(image, s, s);
        let c_in = resized.shape()[0];
        let (mean, std) = self.spec.normalize.mean_std();

        let mut data = vec![0.0f32; 3 * s * s];
        for c in 0..3 {
            let src_c = if c_in == 1 { 0 } else { c.min(c_in - 1) };
            for y in 0..s {
                for x in 0..s {
                    let v = resized[[src_c, y, x]];
                    data[c * s * s + y * s + x] = (v - mean[c]) / std[c];
                }
            }
        }

        let arr = Array4::from_shape_vec([1, 3, s, s], data)
            .map_err(|e| format!("failed to shape encoder input: {e}"))?;
        Tensor::from_array(arr).map_err(|e| format!("failed to build encoder tensor: {e}"))
    }

    /// Run the encoder and return dense patch features `[D, grid_h, grid_w]`.
    ///
    /// A GPU provider that registers can still fail to *execute* a given graph
    /// — DirectML accepts dynamic spatial axes and then errors inside a
    /// `Reshape`. Rather than surface that as a dead encoder, reopen once on
    /// CPU and carry on: slower beats broken, and the user gets told which
    /// happened. The retry is attempted a single time, after which the session
    /// stays on CPU, so a genuinely malformed graph still fails fast.
    pub fn embed(&mut self, image: &Array3<f32>) -> Result<PatchFeatures, String> {
        match self.run(image) {
            Ok(out) => Ok(out),
            Err(e) if !self.cpu_only => {
                let accel = detect_accelerator();
                log::info!(
                    "[ml] encoder failed on {accel} ({e}); reopening on CPU. \
                     This graph's dynamic shapes are not supported by that \
                     provider — for NVIDIA acceleration install cuDNN 9 so the \
                     CUDA provider can load."
                );
                let spec = self.spec.clone();
                let reopened = Self::open(&self.path.clone(), spec, true)?;
                *self = reopened;
                self.run(image)
            }
            Err(e) => Err(e),
        }
    }

    fn run(&mut self, image: &Array3<f32>) -> Result<PatchFeatures, String> {
        let input = self.preprocess(image)?;

        let mut binding = self
            .session
            .create_binding()
            .map_err(|e| format!("failed to create binding: {e}"))?;
        binding
            .bind_input(&self.input_name, &input)
            .map_err(|e| format!("failed to bind '{}': {e}", self.input_name))?;
        let mem = self.session.allocator().memory_info();
        for name in &self.output_names {
            binding
                .bind_output_to_device(name, &mem)
                .map_err(|e| format!("failed to bind output '{name}': {e}"))?;
        }

        let outputs = self
            .session
            .run_binding(&binding)
            .map_err(|e| format!("encoder inference failed: {e}"))?;

        // Pick whichever declared output actually came back as a dense map.
        let mut best: Option<(Vec<usize>, Vec<f32>)> = None;
        for name in &self.output_names {
            let Some(value) = outputs.get(name.as_str()) else {
                continue;
            };
            let Ok((shape, data)) = value.try_extract_tensor::<f32>() else {
                continue;
            };
            let shape: Vec<usize> = shape.iter().map(|d| *d as usize).collect();
            if shape.len() < 3 {
                continue; // pooled/class vector — not a dense map
            }
            let elems: usize = shape.iter().product();
            if best.as_ref().map(|(_, d)| elems > d.len()).unwrap_or(true) {
                best = Some((shape, data.to_vec()));
            }
        }

        let (shape, data) =
            best.ok_or_else(|| "encoder produced no dense (rank>=3) output".to_string())?;
        let grid = decode_tokens(&shape, data)?;
        Ok(PatchFeatures { data: grid })
    }

    /// Catalog id of the loaded encoder, for cache keys and reporting.
    pub fn encoder_id(&self) -> &str {
        &self.spec.id
    }

}

/// Reshape a raw encoder output into `[D, grid_h, grid_w]`.
///
/// Handles the two layouts in the wild:
/// * `[B, D, gh, gw]` — already a map (SAM-style).
/// * `[B, T, D]` — a token sequence. Any leading non-patch tokens (CLS, and the
///   register tokens some DINOv2 variants add) are dropped by taking the
///   largest trailing perfect square, which avoids hard-coding a count.
/// Open a graph and report its dense-feature grid, for verifying an export.
///
/// A catalog entry can be perfectly described and still be unusable: a graph
/// may carry control flow that `ort` rejects at load, which no amount of
/// correct metadata fixes. This is the check that distinguishes "the spec is
/// right" from "the file works", and it needs a real download, so it is opt-in.
///
/// ```text
/// DIDA_ENCODER_ONNX=<path> cargo test --lib encoder_graph_loads -- --ignored --nocapture
/// ```
#[cfg(test)]
fn probe_graph(path: &Path, spec: EncoderSpec) -> Result<(usize, usize, usize), String> {
    let size = spec.input_size as usize;
    let mut session = EncoderSession::load(path, spec)?;
    let image = Array3::<f32>::zeros((3, size, size));
    let out = session.embed(&image)?;
    let s = out.data.shape();
    Ok((s[0], s[1], s[2]))
}

fn decode_tokens(shape: &[usize], data: Vec<f32>) -> Result<Array3<f32>, String> {
    match shape.len() {
        4 => {
            let (d, gh, gw) = (shape[1], shape[2], shape[3]);
            Array3::from_shape_vec((d, gh, gw), data)
                .map_err(|e| format!("failed to shape [D,gh,gw] features: {e}"))
        }
        3 => {
            let (t, d) = (shape[1], shape[2]);
            let side = (t as f64).sqrt().floor() as usize;
            if side == 0 {
                return Err(format!("encoder returned {t} tokens; cannot form a grid"));
            }
            let n_patch = side * side;
            let prefix = t - n_patch;
            let mut out = Array3::<f32>::zeros((d, side, side));
            for i in 0..n_patch {
                let (y, x) = (i / side, i % side);
                for c in 0..d {
                    out[[c, y, x]] = data[(prefix + i) * d + c];
                }
            }
            Ok(out)
        }
        n => Err(format!("unsupported encoder output rank {n}")),
    }
}

/// Bilinear resample of a `[C, H, W]` volume. Used both to fit images to the
/// encoder input and to lift patch tokens back to working resolution.
/// Bilinear resample of a `[c, h, w]` volume.
///
/// # Why the loop order matters so much here
///
/// This is called to upsample an encoder's token grid to working resolution —
/// `[384, 32, 32]` to `[384, 384, 384]`, 56 million outputs. The channel loop
/// must stay *outermost*: for a C-ordered `[c, h, w]` array a channel-inner loop strides by
/// `h * w` floats (590 KB at this size) on every step: a cache miss on each of
/// the four gathers, for every output. Measured at 6.2 s per frame — larger than
/// the ViT forward it follows, and it kept being misread as encoder cost.
///
/// Channel outermost walks contiguous memory, the sample points and weights are
/// computed once per axis instead of per element, and channels are independent
/// so they parallelise cleanly.
pub fn resize_bilinear(src: &Array3<f32>, out_h: usize, out_w: usize) -> Array3<f32> {
    use rayon::prelude::*;

    let (c, h, w) = (src.shape()[0], src.shape()[1], src.shape()[2]);
    let mut out = Array3::<f32>::zeros((c, out_h, out_w));
    if h == 0 || w == 0 || out_h == 0 || out_w == 0 || c == 0 {
        return out;
    }

    // Half-pixel centres keep the sampling grid symmetric.
    let taps = |n_out: usize, n_in: usize| -> Vec<(usize, usize, f32)> {
        let s = n_in as f32 / n_out as f32;
        (0..n_out)
            .map(|o| {
                let f = ((o as f32 + 0.5) * s - 0.5).clamp(0.0, (n_in - 1) as f32);
                let i0 = f.floor() as usize;
                (i0, (i0 + 1).min(n_in - 1), f - i0 as f32)
            })
            .collect()
    };
    let xs = taps(out_w, w);
    let ys = taps(out_h, h);

    // `as_standard_layout` is a no-op when the input is already contiguous,
    // which it is for decoded tokens.
    let src_std = src.as_standard_layout();
    let src_s = src_std.as_slice().expect("standard layout is contiguous");
    let out_s = out.as_slice_mut().expect("freshly allocated array is contiguous");

    out_s
        .par_chunks_mut(out_h * out_w)
        .enumerate()
        .for_each(|(ch, plane)| {
            let base = ch * h * w;
            for (oy, &(y0, y1, wy)) in ys.iter().enumerate() {
                let r0 = base + y0 * w;
                let r1 = base + y1 * w;
                let row = &mut plane[oy * out_w..(oy + 1) * out_w];
                for (dst, &(x0, x1, wx)) in row.iter_mut().zip(xs.iter()) {
                    let top = src_s[r0 + x0] * (1.0 - wx) + src_s[r0 + x1] * wx;
                    let bot = src_s[r1 + x0] * (1.0 - wx) + src_s[r1 + x1] * wx;
                    *dst = top * (1.0 - wy) + bot * wy;
                }
            }
        });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The original implementation, kept as the reference the fast path must
    /// reproduce exactly. Reordering loops and precomputing weights must change
    /// only the speed — a resample that shifts by half a pixel would move every
    /// feature off its label and be near-impossible to spot from accuracy alone.
    fn resize_bilinear_reference(src: &Array3<f32>, out_h: usize, out_w: usize) -> Array3<f32> {
        let (c, h, w) = (src.shape()[0], src.shape()[1], src.shape()[2]);
        let mut out = Array3::<f32>::zeros((c, out_h, out_w));
        if h == 0 || w == 0 || out_h == 0 || out_w == 0 {
            return out;
        }
        let sy = h as f32 / out_h as f32;
        let sx = w as f32 / out_w as f32;
        for oy in 0..out_h {
            let fy = ((oy as f32 + 0.5) * sy - 0.5).clamp(0.0, (h - 1) as f32);
            let y0 = fy.floor() as usize;
            let y1 = (y0 + 1).min(h - 1);
            let wy = fy - y0 as f32;
            for ox in 0..out_w {
                let fx = ((ox as f32 + 0.5) * sx - 0.5).clamp(0.0, (w - 1) as f32);
                let x0 = fx.floor() as usize;
                let x1 = (x0 + 1).min(w - 1);
                let wx = fx - x0 as f32;
                for ch in 0..c {
                    let top = src[[ch, y0, x0]] * (1.0 - wx) + src[[ch, y0, x1]] * wx;
                    let bot = src[[ch, y1, x0]] * (1.0 - wx) + src[[ch, y1, x1]] * wx;
                    out[[ch, oy, ox]] = top * (1.0 - wy) + bot * wy;
                }
            }
        }
        out
    }

    #[test]
    fn the_fast_resample_matches_the_reference_exactly() {
        // Upsample, downsample, identity, non-square, and single-pixel input —
        // the clamping edge cases are where a rewrite goes wrong.
        for &(c, h, w, oh, ow) in &[
            (5usize, 4usize, 6usize, 17usize, 13usize), // up, non-square
            (3, 9, 9, 4, 4),                            // down
            (2, 5, 5, 5, 5),                            // identity
            (4, 1, 1, 6, 6),                            // degenerate source
            (1, 3, 7, 21, 3),                           // stretch one axis, shrink other
        ] {
            let src = Array3::from_shape_fn((c, h, w), |(k, y, x)| {
                (k * 31 + y * 7 + x * 3) as f32 * 0.25 - 4.0
            });
            let fast = resize_bilinear(&src, oh, ow);
            let reference = resize_bilinear_reference(&src, oh, ow);
            assert_eq!(fast.shape(), reference.shape());
            for (a, b) in fast.iter().zip(reference.iter()) {
                assert_eq!(a, b, "resample changed for {c}x{h}x{w} -> {oh}x{ow}");
            }
        }
    }

    #[test]
    fn resampling_a_degenerate_target_is_empty_not_a_panic() {
        let src = Array3::from_shape_fn((2, 3, 3), |(k, y, x)| (k + y + x) as f32);
        assert_eq!(resize_bilinear(&src, 0, 5).len(), 0);
        assert_eq!(resize_bilinear(&src, 5, 0).len(), 0);
    }

    #[test]
    fn decodes_map_layout() {
        // [B, D, gh, gw]
        let data: Vec<f32> = (0..(2 * 2 * 3)).map(|v| v as f32).collect();
        let out = decode_tokens(&[1, 2, 2, 3], data).unwrap();
        assert_eq!(out.shape(), &[2, 2, 3]);
        assert_eq!(out[[0, 0, 0]], 0.0);
        assert_eq!(out[[1, 0, 0]], 6.0);
    }

    #[test]
    fn decodes_token_layout_dropping_prefix_tokens() {
        // 1 CLS + 4 patches, D=2 -> 2x2 grid, CLS dropped.
        let d = 2;
        let mut data = vec![-1.0f32; d]; // CLS token, must be discarded
        for i in 0..4 {
            data.push(i as f32); // channel 0
            data.push(10.0 + i as f32); // channel 1
        }
        let out = decode_tokens(&[1, 5, d], data).unwrap();
        assert_eq!(out.shape(), &[2, 2, 2]);
        assert_eq!(out[[0, 0, 0]], 0.0);
        assert_eq!(out[[0, 1, 1]], 3.0);
        assert_eq!(out[[1, 0, 0]], 10.0);
        assert!(out.iter().all(|&v| v >= 0.0), "CLS token leaked into grid");
    }

    #[test]
    fn decodes_token_layout_with_register_tokens() {
        // DINOv2-with-registers style: 1 CLS + 4 registers + 9 patches -> 3x3.
        let (d, t) = (3usize, 14usize);
        let data = vec![1.0f32; t * d];
        let out = decode_tokens(&[1, t, d], data).unwrap();
        assert_eq!(out.shape(), &[3, 3, 3]);
    }

    #[test]
    fn rejects_pooled_output() {
        assert!(decode_tokens(&[1, 384], vec![0.0; 384]).is_err());
    }

    #[test]
    fn bilinear_resize_preserves_constants_and_shape() {
        let src = Array3::from_elem((2, 4, 4), 0.25);
        let up = resize_bilinear(&src, 8, 8);
        assert_eq!(up.shape(), &[2, 8, 8]);
        assert!(up.iter().all(|v| (v - 0.25).abs() < 1e-5));

        let down = resize_bilinear(&src, 2, 2);
        assert_eq!(down.shape(), &[2, 2, 2]);
        assert!(down.iter().all(|v| (v - 0.25).abs() < 1e-5));
    }

    #[test]
    fn bilinear_resize_interpolates_a_ramp_monotonically() {
        let src = Array3::from_shape_fn((1, 1, 4), |(_, _, x)| x as f32);
        let up = resize_bilinear(&src, 1, 8);
        for x in 1..8 {
            assert!(
                up[[0, 0, x]] >= up[[0, 0, x - 1]],
                "not monotonic at {x}: {:?}",
                up
            );
        }
    }

    /// Opt-in: proves a downloaded graph actually opens and produces a grid.
    ///
    /// Ignored because it needs real weights on disk. Point `DIDA_ENCODER_ONNX`
    /// at a cached `model.onnx` and `DIDA_ENCODER_ID` at the catalog entry.
    #[test]
    #[ignore = "needs a downloaded encoder; set DIDA_ENCODER_ONNX"]
    fn encoder_graph_loads() {
        let Ok(path) = std::env::var("DIDA_ENCODER_ONNX") else {
            panic!("set DIDA_ENCODER_ONNX to a cached model.onnx");
        };
        let id = std::env::var("DIDA_ENCODER_ID").unwrap_or_else(|_| "dinov3-vits16".into());
        let spec = crate::commands::ml::registry::find(&id)
            .unwrap_or_else(|| panic!("unknown encoder id '{id}'"));
        let expect = (spec.input_size / spec.patch) as usize;

        let (d, gh, gw) = probe_graph(std::path::Path::new(&path), spec)
            .unwrap_or_else(|e| panic!("{id} failed to load: {e}"));
        log::info!("[probe] {id} -> [{d}, {gh}, {gw}]");
        assert_eq!((gh, gw), (expect, expect), "{id}: unexpected grid");
    }
}
