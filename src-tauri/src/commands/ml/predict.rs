//! Applying a trained head to a single frame.
//!
//! A head is only meaningful against the feature layout it was trained on:
//! inference reuses [`dataset::assemble_stack`] and refuses a width that
//! differs from the model's `feature_dim`.
//!
//! A model trained on tiles predicts on tiles: the frame is covered by
//! overlapping squares at working resolution, each goes through the encoder
//! and the head on its own, and the middle of each is kept.

use ts_rs::TS;
use base64::prelude::BASE64_STANDARD;
use base64::Engine;
use ndarray::Array3;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::storage::DbState;

use super::dataset::{self, downscale_nearest, Tile};
use super::encoder::{resize_bilinear, EncoderSession};
use super::filters::{self, FilterBankConfig};
use super::scribble::{self, Scribbles, SCRIBBLE_CHANNELS};
use super::train::{predict_map_projected, EvalMetrics, Head, Projection};

/// A fitted head and what is needed to rebuild identical features.
pub struct TrainedModel {
    pub head: Head,
    pub feature_dim: usize,
    pub classes: usize,
    /// Label ids in project order; class `i + 1` is `label_order[i]`.
    pub label_order: Vec<i64>,
    pub encoder_id: Option<String>,
    /// 0: native.
    pub working_size: u32,
    /// Side of the tiles the head was trained on; `None` for the whole frame
    /// as one.
    pub tile_size: Option<u32>,
    pub metrics: EvalMetrics,
    pub train_frames: usize,
}

/// Identifies a cached encoder result: frame, encoder, working size and tile
/// size (0 for none). The last two change the images fed to the encoder.
pub type FeatureKey = (i64, String, u32, u32);

/// A frame's encoder token grids, one per tile in grid order.
pub type FeatureCache = Option<(FeatureKey, Vec<Array3<f32>>)>;

/// Past this many tiles a frame's token grids are not kept (about 1.5 MB each
/// with a ViT-S).
const MAX_CACHED_TILES: usize = 256;

#[derive(Default)]
pub struct MlState {
    pub model: Mutex<Option<TrainedModel>>,
    pub encoder: Mutex<Option<(String, EncoderSession)>>,
    /// Last frame's encoder token grids, so predicting the same frame again
    /// with other scribbles does not re-run the encoder.
    pub features: Mutex<FeatureCache>,
    /// Set by `ml_stop_training` and polled between epochs.
    pub cancel: std::sync::atomic::AtomicBool,
}

/// Scribbles supplied by the UI, as flat pixel indices at native resolution.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ScribbleInput {
    #[serde(default)]
    pub positive: Vec<u32>,
    #[serde(default)]
    pub negative: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct PredictedMask {
    #[ts(type = "number")]
    pub label_id: i64,
    /// Base64 of a native-resolution uint8 mask (1 where predicted), encoded
    /// as `rle8` (see `storage::rle`): a few kilobytes, not a byte per pixel.
    pub rle8_base64: String,
    /// Fraction of the frame assigned to this label.
    pub coverage: f32,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct PredictedFrame {
    #[ts(type = "number")]
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

/// The strokes falling in `tile`, as that tile's own scribbles.
fn crop_scribbles(s: &Scribbles, tile: Tile) -> Scribbles {
    let mut out = Scribbles::empty(tile.w, tile.h);
    for y in 0..tile.h {
        let src = (tile.y + y) * s.width + tile.x;
        let dst = y * tile.w;
        out.positive[dst..dst + tile.w].copy_from_slice(&s.positive[src..src + tile.w]);
        out.negative[dst..dst + tile.w].copy_from_slice(&s.negative[src..src + tile.w]);
    }
    out
}

/// Classify one tile: its class per pixel, row-major.
///
/// The same numbers as running the head on `dataset::assemble_stack`, without
/// building that stack. The head's first layer is a 1x1 convolution (`first`),
/// which commutes with bilinear resampling, so the encoder's channels go
/// through it on the token grid and `hidden` planes are upsampled instead of
/// several hundred. Channel order is `assemble_stack`'s: local basis, encoder,
/// scribbles.
fn classify_tile(
    head: &Head,
    first: &Projection,
    classes: usize,
    image: &Array3<f32>,
    tokens: Option<&Array3<f32>>,
    scribbles: &Scribbles,
    fb: &FilterBankConfig,
) -> Result<Vec<i32>, String> {
    let (h, w) = (image.shape()[1], image.shape()[2]);
    let (local, _names) = filters::compute(image, fb);
    let c_local = local.shape()[0];
    let c_encoder = tokens.map_or(0, |t| t.shape()[0]);
    let built = c_local + c_encoder + SCRIBBLE_CHANNELS;
    if built != first.d_in {
        return Err(format!(
            "feature mismatch: head expects {} channels, this configuration builds {}. \
             Retrain, or restore the encoder and working size the head was fitted with.",
            first.d_in, built
        ));
    }

    let mut z = filters::bias_planes(&first.bias, h, w);
    filters::project_into(&mut z, &local, &first.weights, first.d_in, 0);
    drop(local);
    if let Some(tokens) = tokens {
        let (gh, gw) = (tokens.shape()[1], tokens.shape()[2]);
        let mut coarse = Array3::<f32>::zeros((first.hidden, gh, gw));
        filters::project_into(&mut coarse, tokens, &first.weights, first.d_in, c_local);
        filters::add_into(&mut z, &resize_bilinear(&coarse, h, w));
    }
    let planes: Vec<f32> = scribble::channels(scribbles).into_iter().flatten().collect();
    let planes = Array3::from_shape_vec((SCRIBBLE_CHANNELS, h, w), planes)
        .map_err(|e| format!("scribble planes: {e}"))?;
    filters::project_into(&mut z, &planes, &first.weights, first.d_in, c_local + c_encoder);

    let (z, _) = z.into_raw_vec_and_offset();
    Ok(predict_map_projected(head, z, first.hidden, h, w, classes))
}

/// Run a trained head over one frame and return per-label masks at native
/// size. `on_stage(stage, done, total)` reports progress.
pub fn predict_frame(
    db: &DbState,
    model: &TrainedModel,
    frame_id: i64,
    encoder: Option<&mut EncoderSession>,
    cache: &mut FeatureCache,
    scribbles: Option<&ScribbleInput>,
    on_stage: &dyn Fn(&str, usize, usize),
) -> Result<PredictedFrame, String> {
    on_stage("decoding frame", 0, 1);
    let (image, w, h) = dataset::load_working_image(db, frame_id, model.working_size)?;
    let side = dataset::tile_side(model.tile_size);
    let tiles = dataset::tile_grid(w, h, side);
    let margin = side.map_or(0, |t| dataset::tile_overlap(t) / 2);

    let (native_w, native_h) = db
        .with_conn(|conn| crate::storage::queries::get_frame_dimensions(conn, frame_id))
        .map_err(|e| format!("frame {frame_id} dimensions: {e}"))?;
    let scr = scribbles.map(|input| to_working(input, native_w, native_h, w, h));

    // The encoder output depends on the image alone, so it is reused when the
    // same frame is predicted again with other scribbles.
    let key: FeatureKey = (
        frame_id,
        model.encoder_id.clone().unwrap_or_default(),
        model.working_size,
        model.tile_size.unwrap_or(0),
    );
    let mut encoder = encoder;
    let keep = encoder.is_some() && tiles.len() <= MAX_CACHED_TILES;
    let mut tokens_kept: Vec<Array3<f32>> = match cache.take() {
        Some((k, grids)) if keep && k == key => grids,
        _ => Vec::new(),
    };

    let fb = FilterBankConfig::default();
    let first = model.head.projection();
    if first.d_in != model.feature_dim {
        return Err(format!(
            "the saved model describes {} input channels and holds {}; retrain to replace it",
            model.feature_dim, first.d_in
        ));
    }
    let started = std::time::Instant::now();
    let (mut ms_encoder, mut ms_head) = (0.0f32, 0.0f32);
    let mut classes = vec![0u8; w * h];
    for (i, &tile) in tiles.iter().enumerate() {
        on_stage("classifying", i, tiles.len());
        let tile_image = dataset::crop_image(&image, tile);

        let t_encoder = std::time::Instant::now();
        let fresh;
        let tokens: Option<&Array3<f32>> = match encoder.as_deref_mut() {
            None => None,
            Some(enc) if keep => {
                if tokens_kept.len() <= i {
                    tokens_kept.push(enc.embed(&tile_image)?.data);
                }
                Some(&tokens_kept[i])
            }
            Some(enc) => {
                fresh = enc.embed(&tile_image)?.data;
                Some(&fresh)
            }
        };
        ms_encoder += t_encoder.elapsed().as_secs_f32() * 1000.0;

        let tile_scr = match &scr {
            Some(s) => crop_scribbles(s, tile),
            None => Scribbles::empty(tile.w, tile.h),
        };
        let t_head = std::time::Instant::now();
        let tile_classes =
            classify_tile(&model.head, &first, model.classes, &tile_image, tokens, &tile_scr, &fb)?;
        ms_head += t_head.elapsed().as_secs_f32() * 1000.0;

        // Keep the tile's middle; its rim was computed without its surroundings.
        let (x0, x1) = dataset::kept_range(tile.x, tile.w, w, margin);
        let (y0, y1) = dataset::kept_range(tile.y, tile.h, h, margin);
        for y in y0..y1 {
            let dst = (tile.y + y) * w + tile.x;
            for x in x0..x1 {
                classes[dst + x] = tile_classes[y * tile.w + x].clamp(0, 255) as u8;
            }
        }
    }
    log::info!(
        "[ml] predicted frame {frame_id} — {w}x{h}, {} tile(s) in {:.1} s \
         (encoder {ms_encoder:.0} ms, features and head {ms_head:.0} ms, head on {})",
        tiles.len(),
        started.elapsed().as_secs_f32(),
        model.head.device()
    );
    *cache = keep.then_some((key, tokens_kept));

    // Nearest upscale: interpolating class ids would invent classes.
    let full = if (w, h) == (native_w as usize, native_h as usize) {
        classes
    } else {
        downscale_nearest(&classes, w, h, native_w as usize, native_h as usize)
    };

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
                rle8_base64: BASE64_STANDARD.encode(crate::storage::rle::encode8(&mask)),
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

    /// The shortcut through the head's first layer must give what the head
    /// gives on the stack it was trained on.
    #[test]
    fn classifying_a_tile_matches_the_head_on_the_assembled_stack() {
        let (h, w, e, classes) = (40usize, 52usize, 5usize, 3usize);
        let image = Array3::from_shape_fn((3, h, w), |(c, y, x)| ((c * 7 + y * 13 + x * 5) % 31) as f32 / 31.0);
        let tokens = Array3::from_shape_fn((e, 4, 4), |(c, y, x)| ((c * 3 + y * 5 + x * 11) % 17) as f32 / 17.0 - 0.5);
        let mut scr = Scribbles::empty(w, h);
        scr.positive[5 * w + 6] = true;
        scr.negative[30 * w + 40] = true;
        let fb = FilterBankConfig::default();

        let stack = dataset::assemble_stack(&image, Some(&resize_bilinear(&tokens, h, w)), &scr, &fb);
        let d = stack.shape()[0];
        let head = Head::random_cpu(d, 8, 2, classes);
        let (flat, _) = stack.into_raw_vec_and_offset();
        let reference = super::super::train::predict_map(&head, flat, d, h, w, classes);

        let got = classify_tile(&head, &head.projection(), classes, &image, Some(&tokens), &scr, &fb).unwrap();
        // The sums are taken in another order: a pixel on a tie may flip.
        let differing = got.iter().zip(&reference).filter(|(a, b)| a != b).count();
        assert!(differing * 200 <= h * w, "{differing} of {} pixels differ", h * w);

        let short = Head::random_cpu(d - 1, 8, 2, classes);
        assert!(classify_tile(&short, &short.projection(), classes, &image, Some(&tokens), &scr, &fb).is_err());
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
