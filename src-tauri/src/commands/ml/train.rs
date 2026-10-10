//! The trainable head and its optimisation loop.
//!
//! A small dilated CNN over feature patches: `[d, 48, 48]` in, one logit per
//! class per pixel out. Metrics are computed on held-out frames, never on
//! pixels or patches of a frame that was trained on.

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

/// Square side of a training patch: several times the head's receptive field.
pub const PATCH: usize = 48;

/// A batch of feature patches: `x` is `[n, d, PATCH, PATCH]`, `y` is
/// `[n, PATCH, PATCH]`.
#[derive(Debug, Clone, Default)]
pub struct Samples {
    pub x: Vec<f32>,
    pub y: Vec<i32>,
    pub n: usize,
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

    /// Append one patch, row-major: `features` is `[d, PATCH, PATCH]`, `labels`
    /// is `[PATCH, PATCH]`.
    pub fn push_patch(&mut self, features: &[f32], labels: &[i32]) {
        debug_assert_eq!(features.len(), self.d * PATCH * PATCH);
        debug_assert_eq!(labels.len(), PATCH * PATCH);
        self.x.extend_from_slice(features);
        self.y.extend_from_slice(labels);
        self.n += 1;
    }

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
    /// Dilated blocks before the output projection.
    pub depth: usize,
    pub epochs: usize,
    pub lr: f64,
    pub batch: usize,
    pub seed: u64,
}

impl Default for TrainConfig {
    /// Small on purpose: a head is fitted to a few hundred patches, and the
    /// dilated blocks cost `hidden²`.
    fn default() -> Self {
        Self {
            hidden: 64,
            depth: 2,
            epochs: 40,
            lr: 1e-3,
            // In patches.
            batch: 16,
            seed: 0,
        }
    }
}

/// Dilations of the 3x3 stack: a 15 px receptive field with no downsampling.
const DILATIONS: [usize; 3] = [1, 2, 4];

/// Convolutional head: 1x1 projection down to `hidden`, the dilated 3x3
/// stack, then 1x1 to class logits. The leading 1x1 keeps the 3x3 kernels off
/// the full feature width.
#[derive(Module, Debug)]
pub struct SegHead<B: Backend> {
    project: Conv2d<B>,
    blocks: Vec<Conv2d<B>>,
    out: Conv2d<B>,
    act: Relu,
}

impl<B: Backend> SegHead<B> {
    /// `depth` counts dilated 3x3 blocks; the dilation schedule repeats past its
    /// length.
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
                // padding == dilation keeps the output the size of the input.
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

    /// `[n, d, h, w] -> [n, n_classes, h, w]` logits.
    pub fn forward(&self, x: Tensor<B, 4>) -> Tensor<B, 4> {
        let mut h = self.act.forward(self.project.forward(x));
        for block in &self.blocks {
            h = h.clone() + self.act.forward(block.forward(h));
        }
        self.out.forward(h)
    }
}

/// A fitted head and the backend it lives on. A burn tensor belongs to its
/// backend, so the head stays where it was fitted; callers go through
/// [`predict_map`].
#[derive(Debug)]
pub enum Head {
    Cpu(SegHead<CpuInfer>),
    #[cfg(feature = "gpu")]
    Cuda(SegHead<GpuInfer>),
}

impl Head {
    pub const fn device(&self) -> &'static str {
        match self {
            Head::Cpu(_) => Selection::Cpu.label(),
            #[cfg(feature = "gpu")]
            Head::Cuda(_) => Selection::Cuda.label(),
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalMetrics {
    pub accuracy: f32,
    /// Mean Dice over the classes present in the reference.
    pub mean_dice: f32,
    pub per_class_dice: Vec<f32>,
}

fn to_x<B: Backend>(x: Vec<f32>, n: usize, d: usize, device: &B::Device) -> Tensor<B, 4> {
    Tensor::<B, 4>::from_data(TensorData::new(x, [n, d, PATCH, PATCH]), device)
}

/// Flatten `[n, C, H, W]` logits to `[n*H*W, C]`.
fn flatten_logits<B: Backend>(logits: Tensor<B, 4>, n_classes: usize) -> Tensor<B, 2> {
    let [n, c, h, w] = logits.dims();
    debug_assert_eq!(c, n_classes);
    logits.permute([0, 2, 3, 1]).reshape([n * h * w, c])
}

/// Argmax class per pixel across a patch batch.
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

fn class_counts(y: &[i32], n_classes: usize) -> Vec<usize> {
    let mut counts = vec![0usize; n_classes];
    for &c in y {
        if c >= 0 && (c as usize) < n_classes {
            counts[c as usize] += 1;
        }
    }
    counts
}

/// Inverse-frequency class weights, `total / (n_classes * count)`, capped. A
/// class with no pixels gets 1.0.
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

/// Accuracy and per-class Dice against a reference labelling.
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
        // A class absent from the reference is not scored.
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

/// Progress of the optimisation loop, reported per epoch.
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
    pub epoch_ms: f32,
    pub elapsed_ms: f32,
    /// Projected time left across the whole job.
    pub eta_ms: f32,
    /// Where the optimisation is running.
    pub device: &'static str,
    pub samples: usize,
    pub features: usize,
}

/// Fit a head on `train` and score it on `val`, reporting each epoch to `on`.
/// `stop` is polled between epochs; a stopped fit returns its weights
/// normally.
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

/// The optimisation loop, generic over the backend. `cfg.seed` drives batch
/// selection only: weight initialisation uses the backend's own RNG, so runs
/// on different backends are not element-wise identical.
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
    // Inverse-frequency weights, or the loss is dominated by background.
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
            // A minibatch sampled with replacement.
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
            // Of this fit only; the sweep wrapper adds the fits queued behind it.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tiny() -> TrainConfig {
        TrainConfig { epochs: 1, hidden: 4, depth: 1, batch: 2, ..Default::default() }
    }

    /// `n` patches whose class is constant per patch and encoded in the features.
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
        let mut y = vec![0i32; 95];
        y.extend(std::iter::repeat(1).take(5));
        let w = class_weights(&y, 2);
        assert!(w[1] > w[0], "rare class must outweigh common: {w:?}");
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

        // Class 2 never appears in truth, so it is left out of the mean.
        let m = evaluate(&[0, 1], &[0, 1], 3);
        assert!((m.mean_dice - 1.0).abs() < 1e-6, "got {}", m.mean_dice);
    }

    #[test]
    fn evaluate_penalises_a_constant_predictor() {
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
        // Four patches and a high learning rate: this checks that gradients flow.
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
        let empty = Samples::new(4);
        let val = synth(2, 4, 3);
        assert!(train_head_with(&empty, &val, 2, &tiny(), &|| false, &mut |_| {}).is_err());
        let train = synth(2, 4, 4);
        assert!(train_head_with(&train, &val, 1, &tiny(), &|| false, &mut |_| {}).is_err());
    }

    #[test]
    fn dispatch_picks_a_backend_and_fits() {
        let train = synth(4, 3, 7);
        let val = synth(2, 3, 8);
        let (head, _) = train_head_with(&train, &val, 2, &tiny(), &|| false, &mut |_| {}).unwrap();
        assert!(!head.device().is_empty());

        let d = 3;
        let (h, w) = (16, 16);
        let x = vec![0.5f32; d * h * w];
        let out = predict_map(&head, &x, d, h, w, 2);
        assert_eq!(out.len(), h * w);
        assert!(out.iter().all(|&c| c == 0 || c == 1));
    }

}
