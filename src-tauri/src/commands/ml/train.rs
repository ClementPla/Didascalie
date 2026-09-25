//! The trainable head and its optimisation loop.
//!
//! # Shape of the model
//!
//! A small dilated CNN over feature patches: `[d, 48, 48]` in, one logit per
//! class per pixel out. Patches rather than whole frames keep training
//! affordable — a dense feature volume is hundreds of megabytes, a batch of
//! patches a few.
//!
//! # Evaluation is by frame
//!
//! Every reported metric is computed on held-out **frames**, never on held-out
//! pixels or patches of a frame that was trained on. Pixels within an image are
//! strongly correlated, so scoring that way inflates the numbers badly. Keep any
//! new metric on the same footing.
//!
//! Note that `dataset::sample_patches` *does* bias crop origins towards
//! foreground; that bias is confined to which patches are drawn and never
//! reaches the loss weighting or these metrics.

use burn::module::{AutodiffModule, Module};
use burn::nn::loss::CrossEntropyLossConfig;
use burn::nn::conv::{Conv2d, Conv2dConfig};
use burn::nn::{PaddingConfig2d, Relu};
use burn::optim::{AdamConfig, GradientsParams, Optimizer};
use burn::tensor::backend::{AutodiffBackend, Backend};
use burn::tensor::{Int, Tensor, TensorData};

use super::backend::{CpuInfer, CpuTrain, Selection};
#[cfg(feature = "gpu")]
use super::backend::{GpuInfer, GpuTrain};
use super::scribble::Rng;

/// Square side of a training patch.
///
/// Large enough that the dilated stack's ~15px receptive field sits well inside
/// it (so most pixels see real context rather than padding), small enough that a
/// batch stays cheap.
pub const PATCH: usize = 48;

/// A batch of feature patches: `x` is `[n, d, PATCH, PATCH]`, `y` is
/// `[n, PATCH, PATCH]`.
///
/// Patches rather than loose pixels because the head is convolutional now — it
/// needs neighbours to look at. The field name `d` still means channels, so the
/// feature-width checks elsewhere continue to line up.
#[derive(Debug, Clone, Default)]
pub struct Samples {
    pub x: Vec<f32>,
    pub y: Vec<i32>,
    /// Number of patches.
    pub n: usize,
    /// Feature channels.
    pub d: usize,
}

impl Samples {
    pub fn new(d: usize) -> Self {
        Self {
            x: Vec::new(),
            y: Vec::new(),
            n: 0,
            d,
        }
    }

    /// Append one patch: `features` is `[d, PATCH, PATCH]`, `labels` is
    /// `[PATCH, PATCH]`, both row-major.
    pub fn push_patch(&mut self, features: &[f32], labels: &[i32]) {
        debug_assert_eq!(features.len(), self.d * PATCH * PATCH);
        debug_assert_eq!(labels.len(), PATCH * PATCH);
        self.x.extend_from_slice(features);
        self.y.extend_from_slice(labels);
        self.n += 1;
    }

    /// Pixels per patch, for loss and metric shapes.
    pub const fn patch_pixels() -> usize {
        PATCH * PATCH
    }

    pub fn extend(&mut self, other: &Samples) {
        debug_assert_eq!(self.d, other.d);
        self.x.extend_from_slice(&other.x);
        self.y.extend_from_slice(&other.y);
        self.n += other.n;
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
}

#[derive(Debug, Clone)]
pub struct TrainConfig {
    pub hidden: usize,
    /// Hidden layers before the output projection.
    pub depth: usize,
    pub epochs: usize,
    pub lr: f64,
    pub batch: usize,
    pub seed: u64,
}

impl Default for TrainConfig {
    /// Sized for the datasets this lab actually sees.
    ///
    /// `hidden = 128, depth = 3` was ~484,000 parameters, fitted in practice to
    /// a few hundred patches from a handful of reviewed frames — orders of
    /// magnitude more capacity than the supervision can constrain. It also cost
    /// the most where it mattered least: the dilated blocks are `hidden`-to-
    /// `hidden`, so their work scales with `hidden²` and dominated the step.
    ///
    /// 64x2 is roughly an eighth of the parameters and a sixth of the block
    /// FLOPs. On a small annotated set that should train faster *and* generalise
    /// better; raise either knob when there is genuinely more data to justify it.
    fn default() -> Self {
        Self {
            hidden: 64,
            depth: 2,
            epochs: 40,
            lr: 1e-3,
            // Patches, not pixels: each carries PATCH^2 supervised pixels.
            batch: 16,
            seed: 0,
        }
    }
}

/// Dilation schedule for the 3x3 stack.
///
/// 1, 2, 4 gives a receptive field of 1 + 2*(1+2+4) = 15 px without any
/// downsampling, so the head gains context while every output pixel keeps its
/// exact position. Striding or pooling would blur boundaries — the precise
/// thing a segmentation head must not do.
const DILATIONS: [usize; 3] = [1, 2, 4];

/// Convolutional segmentation head: 1x1 projection down to `hidden`, the
/// dilated 3x3 stack, then 1x1 to class logits.
///
/// The leading 1x1 is what makes the cost bearable: with an encoder attached
/// `d_in` reaches ~475, and 3x3 kernels at that width would dominate the whole
/// training budget.
#[derive(Module, Debug)]
pub struct SegHead<B: Backend> {
    project: Conv2d<B>,
    blocks: Vec<Conv2d<B>>,
    out: Conv2d<B>,
    act: Relu,
}

impl<B: Backend> SegHead<B> {
    /// `depth` counts dilated 3x3 blocks; the dilation schedule repeats if
    /// depth exceeds it, which keeps growing the receptive field.
    pub fn with_depth(
        d_in: usize,
        hidden: usize,
        depth: usize,
        n_classes: usize,
        device: &B::Device,
    ) -> Self {
        let depth = depth.max(1);
        let blocks = (0..depth)
            .map(|i| {
                let d = DILATIONS[i % DILATIONS.len()];
                // padding == dilation keeps 3x3 output the same size as input.
                Conv2dConfig::new([hidden, hidden], [3, 3])
                    .with_dilation([d, d])
                    .with_padding(PaddingConfig2d::Explicit(d, d, d, d))
                    .init(device)
            })
            .collect();
        Self {
            project: Conv2dConfig::new([d_in, hidden], [1, 1]).init(device),
            blocks,
            out: Conv2dConfig::new([hidden, n_classes], [1, 1]).init(device),
            act: Relu::new(),
        }
    }

    /// `[n, d, h, w] -> [n, n_classes, h, w]` logits, spatial size preserved.
    pub fn forward(&self, x: Tensor<B, 4>) -> Tensor<B, 4> {
        let mut h = self.act.forward(self.project.forward(x));
        for block in &self.blocks {
            // Residual so a deeper stack cannot do worse than a shallower one
            // at initialisation, which matters when depth is user-configurable.
            h = h.clone() + self.act.forward(block.forward(h));
        }
        self.out.forward(h)
    }
}

/// A fitted head, together with the backend it lives on.
///
/// A burn tensor belongs to its backend's device, so a head trained on CUDA
/// cannot be handed a CPU tensor — the two are different Rust types. Rather
/// than convert weights across (which would mean a second, slower inference
/// path for no benefit), the head simply stays where it was fitted and this
/// enum records where that is. Callers go through [`predict_map`] and never
/// name a backend.
#[derive(Debug)]
pub enum Head {
    Cpu(SegHead<CpuInfer>),
    #[cfg(feature = "gpu")]
    Cuda(SegHead<GpuInfer>),
}

impl Head {
    /// Which backend this head runs on, for logs and the UI.
    pub const fn device(&self) -> &'static str {
        match self {
            Head::Cpu(_) => Selection::Cpu.label(),
            #[cfg(feature = "gpu")]
            Head::Cuda(_) => Selection::Cuda.label(),
        }
    }
}

/// Held-out quality for one trained head.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalMetrics {
    pub accuracy: f32,
    /// Mean Dice over classes actually present in the reference.
    pub mean_dice: f32,
    pub per_class_dice: Vec<f32>,
}

/// `[n, d, PATCH, PATCH]` from a patch batch.
fn to_x<B: Backend>(x: Vec<f32>, n: usize, d: usize, device: &B::Device) -> Tensor<B, 4> {
    Tensor::<B, 4>::from_data(TensorData::new(x, [n, d, PATCH, PATCH]), device)
}

/// Flatten `[n, C, H, W]` logits to `[n*H*W, C]` so the loss and argmax operate
/// per pixel regardless of how pixels were grouped into patches.
fn flatten_logits<B: Backend>(logits: Tensor<B, 4>, n_classes: usize) -> Tensor<B, 2> {
    let [n, c, h, w] = logits.dims();
    debug_assert_eq!(c, n_classes);
    // [n, c, h, w] -> [n, h, w, c] -> [n*h*w, c]
    logits.permute([0, 2, 3, 1]).reshape([n * h * w, c])
}

/// Argmax class per pixel across a patch batch, in patch-row-major order.
fn predict<B: Backend>(
    model: &SegHead<B>,
    s: &Samples,
    n_classes: usize,
    device: &B::Device,
) -> Vec<i32> {
    if s.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(s.n * Samples::patch_pixels());
    // Chunked so a large validation set never becomes one huge tensor.
    const CHUNK: usize = 16;
    let stride = s.d * Samples::patch_pixels();
    let mut start = 0usize;
    while start < s.n {
        let end = (start + CHUNK).min(s.n);
        let slice = s.x[start * stride..end * stride].to_vec();
        let logits = model.forward(to_x::<B>(slice, end - start, s.d, device));
        let idx = flatten_logits(logits, n_classes).argmax(1).into_data();
        out.extend(idx.iter::<i64>().map(|v| v as i32));
        start = end;
    }
    out
}

/// Argmax class per pixel for one whole feature map `[d, h, w]`, on whichever
/// backend `model` was fitted on.
fn predict_map_on<B: Backend>(
    model: &SegHead<B>,
    x: &[f32],
    d: usize,
    h: usize,
    w: usize,
    n_classes: usize,
) -> Vec<i32> {
    let device = Default::default();
    let t = Tensor::<B, 4>::from_data(TensorData::new(x.to_vec(), [1, d, h, w]), &device);
    let idx = flatten_logits(model.forward(t), n_classes).argmax(1).into_data();
    idx.iter::<i64>().map(|v| v as i32).collect()
}

/// Argmax class per pixel for one whole feature map `[d, h, w]`.
///
/// The dense-inference entry point. A convolutional head must see the map
/// intact — chunking by pixel as the MLP did would destroy exactly the
/// neighbourhood the head exists to use — so the frame is run in one pass.
pub fn predict_map(
    head: &Head,
    x: &[f32],
    d: usize,
    h: usize,
    w: usize,
    n_classes: usize,
) -> Vec<i32> {
    if d == 0 || h == 0 || w == 0 {
        return Vec::new();
    }
    match head {
        Head::Cpu(m) => predict_map_on(m, x, d, h, w, n_classes),
        #[cfg(feature = "gpu")]
        Head::Cuda(m) => predict_map_on(m, x, d, h, w, n_classes),
    }
}

/// Supervised pixel count per class.
fn class_counts(y: &[i32], n_classes: usize) -> Vec<usize> {
    let mut counts = vec![0usize; n_classes];
    for &c in y {
        if c >= 0 && (c as usize) < n_classes {
            counts[c as usize] += 1;
        }
    }
    counts
}

/// Inverse-frequency class weights, as `total / (n_classes * count)`.
///
/// The "balanced" convention: a class holding its proportional share gets 1.0,
/// rarer classes more. Capped, because a class present in a handful of pixels
/// would otherwise earn a weight large enough to make the loss lurch and drown
/// out everything else. A class with no pixels at all gets 1.0 — it never
/// appears in a target, so the value is inert, and 0 would risk a NaN.
fn class_weights(y: &[i32], n_classes: usize) -> Vec<f32> {
    const MAX_WEIGHT: f32 = 50.0;
    let counts = class_counts(y, n_classes);
    let total: usize = counts.iter().sum();
    if total == 0 || n_classes == 0 {
        return vec![1.0; n_classes];
    }
    counts
        .iter()
        .map(|&c| {
            if c == 0 {
                1.0
            } else {
                (total as f32 / (n_classes as f32 * c as f32)).min(MAX_WEIGHT)
            }
        })
        .collect()
}

/// Accuracy plus per-class Dice against a reference labelling.
pub fn evaluate(pred: &[i32], truth: &[i32], n_classes: usize) -> EvalMetrics {
    if pred.is_empty() || pred.len() != truth.len() {
        return EvalMetrics::default();
    }
    let correct = pred.iter().zip(truth).filter(|(a, b)| a == b).count();
    let mut per_class = vec![0.0f32; n_classes];
    let mut present = 0usize;
    let mut sum = 0.0f32;
    for c in 0..n_classes as i32 {
        let inter = pred
            .iter()
            .zip(truth)
            .filter(|&(&p, &t)| p == c && t == c)
            .count() as f32;
        let np = pred.iter().filter(|&&p| p == c).count() as f32;
        let nt = truth.iter().filter(|&&t| t == c).count() as f32;
        // A class absent from the reference is not scored: including a
        // free 1.0 for correctly predicting nothing would flatter the curve.
        if nt == 0.0 {
            continue;
        }
        let dice = if np + nt > 0.0 {
            2.0 * inter / (np + nt)
        } else {
            0.0
        };
        per_class[c as usize] = dice;
        sum += dice;
        present += 1;
    }
    EvalMetrics {
        accuracy: correct as f32 / pred.len() as f32,
        mean_dice: if present > 0 {
            sum / present as f32
        } else {
            0.0
        },
        per_class_dice: per_class,
    }
}

/// A tick from inside the optimisation loop.
///
/// Training dominates a sweep's wall-clock, so it reports per epoch rather than
/// per fit — a silent progress bar during the slowest phase reads as a hang.
/// `loss` is included because a falling loss is the signal that tells a user
/// the run is healthy, not merely alive.
#[derive(Debug, Clone, Copy)]
pub struct TrainProgress {
    pub budget: usize,
    pub repeat: usize,
    pub epoch: usize,
    pub epochs: usize,
    pub loss: f32,
    /// Position within a sweep; both zero for a single fit.
    pub point: usize,
    pub points: usize,
    /// Wall-clock for the epoch just finished.
    pub epoch_ms: f32,
    /// Wall-clock since this fit started.
    pub elapsed_ms: f32,
    /// Projected time left across the *whole* job, not just this fit.
    pub eta_ms: f32,
    /// Where the optimisation is actually running. Worth surfacing: this
    /// backend is CPU-only, so a user expecting GPU acceleration should be
    /// told rather than left to infer it from the speed.
    pub device: &'static str,
    pub samples: usize,
    pub features: usize,
}

/// Fit a head on `train` and score it on `val`, reporting each epoch to `on`.
///
/// Backend choice happens here, once, after the cheap rejections — spinning up
/// a CUDA context only to discover the request was degenerate would add a
/// second of latency to an error.
///
/// `stop` is polled between epochs. A stopped fit is **not** an error: the
/// weights at that point are a real model, just less trained, so it returns
/// normally and the caller keeps a usable head. Treating interruption as
/// failure would throw away work the user explicitly chose to keep.
pub fn train_head_with(
    train: &Samples,
    val: &Samples,
    n_classes: usize,
    cfg: &TrainConfig,
    stop: &dyn Fn() -> bool,
    on: &mut dyn FnMut(TrainProgress),
) -> Result<(Head, EvalMetrics), String> {
    if train.is_empty() {
        return Err("no training samples".into());
    }
    if n_classes < 2 {
        return Err("need at least two classes".into());
    }
    match Selection::detect() {
        #[cfg(feature = "gpu")]
        sel @ Selection::Cuda => fit::<GpuTrain>(train, val, n_classes, cfg, sel.label(), stop, on)
            .map(|(h, m)| (Head::Cuda(h), m)),
        sel @ Selection::Cpu => fit::<CpuTrain>(train, val, n_classes, cfg, sel.label(), stop, on)
            .map(|(h, m)| (Head::Cpu(h), m)),
    }
}

/// The optimisation loop, generic over the backend it runs on.
///
/// Everything device-specific is confined to `device` and the tensor types, so
/// CPU and GPU runs are the same code and cannot drift apart — a real risk if
/// the two paths were written separately, since a subtle difference would show
/// up as "the GPU gives different numbers" rather than as a compile error.
///
/// Note that identical *code* is not identical *numbers*: `cfg.seed` drives
/// batch selection, which is CPU-side and reproducible, but weight
/// initialisation uses the backend's own RNG. Two runs of the same config on
/// different backends are therefore comparable in distribution, not
/// element-wise — a caveat that matters when reading a learning curve produced
/// on one machine against a curve produced on another.
fn fit<B: AutodiffBackend>(
    train: &Samples,
    val: &Samples,
    n_classes: usize,
    cfg: &TrainConfig,
    device_label: &'static str,
    stop: &dyn Fn() -> bool,
    on: &mut dyn FnMut(TrainProgress),
) -> Result<(SegHead<B::InnerBackend>, EvalMetrics), String> {
    let device = Default::default();
    let mut model =
        SegHead::<B>::with_depth(train.d, cfg.hidden, cfg.depth, n_classes, &device);
    let mut optim = AdamConfig::new().init();
    // Weight classes by inverse frequency. Without this the loss is dominated by
    // background — a small structure is ~1% of a frame, so "predict background
    // everywhere" scores ~99% accuracy and is a stable minimum the head will not
    // leave. Foreground-biased *sampling* raises the positive rate but does not
    // remove the imbalance inside each patch; weighting the loss does.
    let weights = class_weights(&train.y, n_classes);
    log::info!(
        "[ml] class balance {:?} -> weights {:?}",
        class_counts(&train.y, n_classes),
        weights.iter().map(|w| (w * 100.0).round() / 100.0).collect::<Vec<_>>()
    );
    let loss_fn = CrossEntropyLossConfig::new()
        .with_weights(Some(weights))
        .init(&device);
    let mut rng = Rng::new(cfg.seed);

    let batch = cfg.batch.min(train.n).max(1);
    let batches_per_epoch = (train.n + batch - 1) / batch;

    // Report the table's footprint and the total step count: both scale with
    // patches-per-frame, and a budget that looks harmless per frame can reach
    // gigabytes once an encoder widens `d` to a few hundred channels. Paging is
    // indistinguishable from "training got slow" unless the number is visible.
    let table_mb =
        (train.n * train.d * Samples::patch_pixels() * std::mem::size_of::<f32>()) as f64 / 1e6;
    log::info!(
        "[ml] fit start — device={} samples={} features={} classes={} hidden={}x{} \
         epochs={} batch={} steps={} table={:.0} MB",
        device_label,
        train.n,
        train.d,
        n_classes,
        cfg.hidden,
        cfg.depth,
        cfg.epochs,
        batch,
        cfg.epochs * batches_per_epoch,
        table_mb
    );
    let fit_start = std::time::Instant::now();

    for epoch in 0..cfg.epochs {
        // Checked between epochs rather than between batches: a partial epoch
        // leaves the minibatch sampler mid-sweep for no benefit, and one epoch
        // is already the granularity progress is reported at, so the user never
        // waits longer than the interval they can see ticking.
        if stop() {
            log::info!(
                "[ml] fit stopped by request after {} of {} epochs — keeping the \
                 weights trained so far",
                epoch, cfg.epochs
            );
            break;
        }
        let epoch_start = std::time::Instant::now();
        let mut epoch_loss = 0.0f32;
        for _ in 0..batches_per_epoch {
            // Sample a minibatch with replacement — cheap, and avoids
            // materialising a shuffled index per epoch.
            let px = Samples::patch_pixels();
            let xstride = train.d * px;
            let mut bx = Vec::with_capacity(batch * xstride);
            let mut by = Vec::with_capacity(batch * px);
            for _ in 0..batch {
                let i = rng.below(train.n);
                bx.extend_from_slice(&train.x[i * xstride..(i + 1) * xstride]);
                by.extend_from_slice(&train.y[i * px..(i + 1) * px]);
            }
            let x = to_x::<B>(bx, batch, train.d, &device);
            // Every pixel of every patch contributes to the loss, so a small
            // patch batch still carries batch*2304 supervised pixels.
            let y = Tensor::<B, 1, Int>::from_data(
                TensorData::new(by, [batch * px]),
                &device,
            );

            let logits = flatten_logits(model.forward(x), n_classes);
            let loss = loss_fn.forward(logits, y);
            epoch_loss += loss
                .clone()
                .into_data()
                .iter::<f32>()
                .next()
                .unwrap_or(0.0);
            let grads = GradientsParams::from_grads(loss.backward(), &model);
            model = optim.step(cfg.lr, model, grads);
        }
        let epoch_ms = epoch_start.elapsed().as_secs_f32() * 1000.0;
        let elapsed_ms = fit_start.elapsed().as_secs_f32() * 1000.0;
        let avg_ms = elapsed_ms / (epoch + 1) as f32;
        let loss = epoch_loss / batches_per_epoch.max(1) as f32;

        log::info!(
            "[ml] epoch {}/{} — loss {:.4} — {:.0} ms (avg {:.0} ms)",
            epoch + 1,
            cfg.epochs,
            loss,
            epoch_ms,
            avg_ms
        );

        on(TrainProgress {
            budget: 0,
            repeat: 0,
            epoch: epoch + 1,
            epochs: cfg.epochs,
            loss,
            point: 0,
            points: 0,
            epoch_ms,
            elapsed_ms,
            // Remaining epochs of this fit only; the sweep wrapper widens this
            // to cover the fits still queued behind it.
            eta_ms: avg_ms * (cfg.epochs.saturating_sub(epoch + 1)) as f32,
            device: device_label,
            samples: train.n,
            features: train.d,
        });
    }
    log::info!(
        "[ml] fit done — {:.1} s",
        fit_start.elapsed().as_secs_f32()
    );

    let model = model.valid();
    let metrics = if val.is_empty() {
        EvalMetrics::default()
    } else {
        let infer_device = Default::default();
        let pred = predict::<B::InnerBackend>(&model, val, n_classes, &infer_device);
        evaluate(&pred, &val.y, n_classes)
    };
    Ok((model, metrics))
}

/// One point of a learning curve.
/// Sweep annotation budgets and report held-out quality at each.
///
#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal config: these tests check wiring, not capacity.
    fn tiny() -> TrainConfig {
        TrainConfig { epochs: 1, hidden: 4, depth: 1, batch: 2, ..Default::default() }
    }

    /// `n` patches whose class is constant per patch and encoded in the
    /// features, so a working head must reach high accuracy.
    fn synth(n: usize, d: usize, seed: u64) -> Samples {
        let mut s = Samples::new(d);
        let mut rng = Rng::new(seed);
        let px = Samples::patch_pixels();
        for i in 0..n {
            let cls = (i % 2) as i32;
            let centre = if cls == 0 { -1.0 } else { 1.0 };
            let feats: Vec<f32> = (0..d * px)
                .map(|_| centre + (rng.unit() - 0.5) * 0.8)
                .collect();
            s.push_patch(&feats, &vec![cls; px]);
        }
        s
    }

    #[test]
    fn rare_classes_outweigh_common_ones() {
        // 95% background, 5% foreground — the shape that produced blank masks.
        let mut y = vec![0i32; 95];
        y.extend(std::iter::repeat(1).take(5));
        let w = class_weights(&y, 2);
        assert!(w[1] > w[0], "rare class must outweigh common: {w:?}");
        // Balanced convention: a proportional class sits at 1.0.
        assert!((w[0] - 100.0 / (2.0 * 95.0)).abs() < 1e-4, "{w:?}");
    }

    #[test]
    fn a_balanced_split_leaves_weights_at_one() {
        let y: Vec<i32> = (0..100).map(|i| (i % 2) as i32).collect();
        for w in class_weights(&y, 2) {
            assert!((w - 1.0).abs() < 1e-5, "balanced data should not reweight");
        }
    }

    #[test]
    fn weights_stay_finite_for_absent_and_tiny_classes() {
        let mut y = vec![0i32; 10_000];
        y.push(1); // one pixel of class 1; class 2 absent entirely
        let w = class_weights(&y, 3);
        assert!(w.iter().all(|v| v.is_finite() && *v > 0.0), "{w:?}");
        assert!(w[1] <= 50.0, "weight must be capped, got {}", w[1]);
        assert_eq!(w[2], 1.0, "absent class gets an inert weight");
    }

    #[test]
    fn evaluate_scores_perfect_and_ignores_absent_classes() {
        let m = evaluate(&[0, 1, 1, 0], &[0, 1, 1, 0], 2);
        assert!((m.accuracy - 1.0).abs() < 1e-6);
        assert!((m.mean_dice - 1.0).abs() < 1e-6);

        // Class 2 never appears in truth -> excluded from the mean, so a
        // perfect result on the present classes still scores 1.0.
        let m = evaluate(&[0, 1], &[0, 1], 3);
        assert!((m.mean_dice - 1.0).abs() < 1e-6, "got {}", m.mean_dice);
    }

    #[test]
    fn evaluate_penalises_a_constant_predictor() {
        // Always predicting class 0 when truth is balanced.
        let pred = vec![0; 8];
        let truth: Vec<i32> = (0..8).map(|i| (i % 2) as i32).collect();
        let m = evaluate(&pred, &truth, 2);
        assert!((m.accuracy - 0.5).abs() < 1e-6);
        assert!(m.mean_dice < 0.5, "constant predictor scored {}", m.mean_dice);
    }

    #[test]
    fn evaluate_handles_mismatched_and_empty_input() {
        assert_eq!(evaluate(&[], &[], 2).accuracy, 0.0);
        assert_eq!(evaluate(&[0, 1], &[0], 2).accuracy, 0.0);
    }

    #[test]
    fn head_learns_a_separable_problem() {
        let train = synth(4, 3, 1);
        let val = synth(2, 3, 2);
        // A 48x48 patch is expensive on CPU, so the budget is spent on *steps*
        // rather than data: four patches and a high learning rate. The problem
        // is separable by the sign of a single channel, so what is being tested
        // is that gradients flow end to end, not that the head has capacity.
        let cfg = TrainConfig {
            epochs: 20,
            hidden: 8,
            depth: 1,
            batch: 4,
            lr: 1e-1,
            ..Default::default()
        };
        let (_, m) = train_head_with(&train, &val, 2, &cfg, &|| false, &mut |_| {}).unwrap();
        assert!(
            m.accuracy > 0.9,
            "head failed to learn a separable problem: acc={} dice={}",
            m.accuracy,
            m.mean_dice
        );
    }

    #[test]
    fn training_rejects_degenerate_requests() {
        // These reject before any backend is selected, so they cost nothing
        // even on a machine where initialising CUDA is slow.
        let empty = Samples::new(4);
        let val = synth(2, 4, 3);
        assert!(train_head_with(&empty, &val, 2, &tiny(), &|| false, &mut |_| {}).is_err());
        let train = synth(2, 4, 4);
        assert!(train_head_with(&train, &val, 1, &tiny(), &|| false, &mut |_| {}).is_err());
    }

    #[test]
    fn dispatch_picks_a_backend_and_fits() {
        // Whichever backend this machine selects, the public entry point must
        // return a usable head and report where it ran.
        let train = synth(4, 3, 7);
        let val = synth(2, 3, 8);
        let (head, _) = train_head_with(&train, &val, 2, &tiny(), &|| false, &mut |_| {}).unwrap();
        assert!(!head.device().is_empty());

        // The fitted head must be usable for dense inference on its own
        // backend — the step that would break if weights and device diverged.
        let d = 3;
        let (h, w) = (16, 16);
        let x = vec![0.5f32; d * h * w];
        let out = predict_map(&head, &x, d, h, w, 2);
        assert_eq!(out.len(), h * w);
        assert!(out.iter().all(|&c| c == 0 || c == 1));
    }

}

