//! Applying a trained head to a single frame.
//!
//! A head is only meaningful against the feature layout it was trained on:
//! inference reuses [`dataset::assemble_stack`] and refuses a width that
//! differs from the model's `feature_dim`.

use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use ndarray::Array3;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::storage::DbState;

use super::dataset::{self, downscale_nearest};
use super::encoder::{resize_bilinear, EncoderSession};
use super::filters::FilterBankConfig;
use super::scribble::Scribbles;
use super::train::{predict_map, EvalMetrics, Head};

/// A fitted head and what is needed to rebuild identical features.
pub struct TrainedModel {
    pub head: Head,
    pub feature_dim: usize,
    pub classes: usize,
    /// Label ids in project order; class `i + 1` is `label_order[i]`.
    pub label_order: Vec<i64>,
    pub encoder_id: Option<String>,
    pub working_size: u32,
    pub metrics: EvalMetrics,
    pub train_frames: usize,
}

/// Identifies a cached encoder result. The working size changes the image fed
/// to the encoder, so it is part of the key.
pub type FeatureKey = (i64, String, u32);

#[derive(Default)]
pub struct MlState {
    pub model: Mutex<Option<TrainedModel>>,
    pub encoder: Mutex<Option<(String, EncoderSession)>>,
    /// Last frame's encoder token grid, so predicting the same frame again with
    /// other scribbles does not re-run the encoder.
    pub features: Mutex<Option<(FeatureKey, Array3<f32>)>>,
    /// Set by `ml_stop_training` and polled between epochs.
    pub cancel: std::sync::atomic::AtomicBool,
}

/// Scribbles supplied by the UI, as flat pixel indices at native resolution.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScribbleInput {
    #[serde(default)]
    pub positive: Vec<u32>,
    #[serde(default)]
    pub negative: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedMask {
    pub label_id: i64,
    /// Base64 of a native-resolution uint8 mask (1 where predicted).
    pub mask_base64: String,
    /// Fraction of the frame assigned to this label.
    pub coverage: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PredictedFrame {
    pub frame_id: i64,
    pub width: u32,
    pub height: u32,
    pub masks: Vec<PredictedMask>,
}

/// Map native-resolution scribble indices onto the working grid.
fn to_working(
    input: &ScribbleInput,
    native_w: u32,
    native_h: u32,
    w: usize,
    h: usize,
) -> Scribbles {
    let mut s = Scribbles::empty(w, h);
    let (nw, nh) = (native_w.max(1) as usize, native_h.max(1) as usize);
    let place = |idx: &[u32], out: &mut Vec<bool>| {
        for &i in idx {
            let i = i as usize;
            if i >= nw * nh {
                continue;
            }
            let x = (i % nw) * w / nw;
            let y = (i / nw) * h / nh;
            if x < w && y < h {
                out[y * w + x] = true;
            }
        }
    };
    place(&input.positive, &mut s.positive);
    place(&input.negative, &mut s.negative);
    s
}

/// Run a trained head over one frame and return per-label masks at native
/// size. `on_stage(stage, done, total)` reports progress.
pub fn predict_frame(
    db: &DbState,
    model: &TrainedModel,
    frame_id: i64,
    encoder: Option<&mut EncoderSession>,
    cache: &mut Option<(FeatureKey, Array3<f32>)>,
    scribbles: Option<&ScribbleInput>,
    on_stage: &dyn Fn(&str, usize, usize),
) -> Result<PredictedFrame, String> {
    on_stage("decoding frame", 0, 4);
    let (image, w, h) = dataset::load_working_image(db, frame_id, model.working_size)?;

    // The encoder output depends on the image alone, so it is reused when the
    // same frame is predicted again with other scribbles.
    let key: FeatureKey = (
        frame_id,
        model.encoder_id.clone().unwrap_or_default(),
        model.working_size,
    );
    if let Some(enc) = encoder {
        let hit = cache.as_ref().is_some_and(|(k, _)| *k == key);
        if !hit {
            on_stage("encoder", 1, 4);
            *cache = Some((key.clone(), enc.embed(&image)?.data));
        }
    } else {
        *cache = None;
    }
    let encoder_part = cache
        .as_ref()
        .filter(|(k, _)| *k == key)
        .map(|(_, tokens)| resize_bilinear(tokens, h, w));

    let (native_w, native_h) = db
        .with_conn(|conn| crate::storage::queries::get_frame_dimensions(conn, frame_id))
        .map_err(|e| format!("frame {frame_id} dimensions: {e}"))?;

    let scr = match scribbles {
        Some(input) => to_working(input, native_w, native_h, w, h),
        None => Scribbles::empty(w, h),
    };

    on_stage("features", 2, 4);
    let feats = dataset::assemble_stack(&image, encoder_part.as_ref(), &scr, &FilterBankConfig::default());
    let d = feats.shape()[0];
    if d != model.feature_dim {
        return Err(format!(
            "feature mismatch: head expects {} channels, this configuration builds {}. \
             Retrain, or restore the encoder and working size the head was fitted with.",
            model.feature_dim, d
        ));
    }

    // One pass over the whole map: the head is convolutional.
    on_stage("classifying", 3, 4);
    let flat: Vec<f32> = feats.iter().copied().collect();
    let classes = predict_map(&model.head, &flat, d, h, w, model.classes);

    // Nearest upscale: interpolating class ids would invent classes.
    let small: Vec<u8> = classes.iter().map(|&c| c.clamp(0, 255) as u8).collect();
    let full = downscale_nearest(&small, w, h, native_w as usize, native_h as usize);

    let n_full = full.len().max(1);
    let masks = model
        .label_order
        .iter()
        .enumerate()
        .map(|(pos, &label_id)| {
            let class = (pos + 1) as u8;
            let mask: Vec<u8> = full.iter().map(|&c| (c == class) as u8).collect();
            let hits = mask.iter().filter(|&&v| v > 0).count();
            PredictedMask {
                label_id,
                mask_base64: BASE64_STANDARD.encode(&mask),
                coverage: hits as f32 / n_full as f32,
            }
        })
        .collect();

    Ok(PredictedFrame {
        frame_id,
        width: native_w,
        height: native_h,
        masks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scribble_indices_map_into_the_working_grid() {
        let input = ScribbleInput {
            positive: vec![0, 50 * 100 + 50],
            negative: vec![99 * 100 + 99],
        };
        let s = to_working(&input, 100, 100, 10, 10);
        assert!(s.positive[0], "top-left corner must map to (0,0)");
        assert!(s.positive[5 * 10 + 5], "centre must map to (5,5)");
        assert!(s.negative[9 * 10 + 9], "bottom-right must map to (9,9)");
        assert_eq!(s.positive.iter().filter(|v| **v).count(), 2);
    }

    #[test]
    fn out_of_range_scribbles_are_ignored() {
        let input = ScribbleInput {
            positive: vec![999_999],
            negative: vec![],
        };
        let s = to_working(&input, 10, 10, 4, 4);
        assert!(s.positive.iter().all(|v| !v), "bogus index must not panic or mark");
    }
}
