//! Bridge from a `.dida` project to trainable sample tables.
//!
//! Per annotated frame: decode the image, rasterise its labels into a dense
//! class map, build the feature stack (local basis ⊕ optional encoder ⊕
//! scribble distances), and sample pixels.
//!
//! # Augmentation, and what is deliberately absent
//!
//! Geometric augmentation is still omitted, but the reasoning that justified it
//! no longer holds and the omission is now a *known gap*. It was sound while the
//! head was a per-pixel MLP: the local basis is isotropic, so a flip only
//! permuted which pixel carried a given feature vector, and a table of sampled
//! pixels came out identical. A convolutional head has spatial extent, so flips
//! and rotations do produce genuinely new training signal. Adding them is the
//! next lever to pull if accuracy plateaus.
//!
//! What augments this architecture today:
//!
//! * **Appearance jitter** (gamma / gain / bias) — genuinely moves feature
//!   values, and is the realistic nuisance across scanners and acquisitions.
//! * **Scribble resampling** — every repeat re-simulates strokes, so the head
//!   sees many conditionings of the same anatomy instead of memorising one.
//!
//! Encoder features are computed once per frame and reused across repeats: the
//! encoder forward pass dominates runtime, and modest photometric jitter
//! perturbs ViT features far less than it perturbs the local basis. This is an
//! approximation, and the one to revisit if augmentation looks ineffective.

use ndarray::{Array3, Axis};

use crate::commands::annotation::decode_to_uint8;
use crate::storage::{queries, DbState};

use super::cache;
use super::encoder::{resize_bilinear, EncoderSession};
use super::filters::{self, FilterBankConfig};
use super::scribble::{self, Rng, Scribbles, SCRIBBLE_CHANNELS};
use super::train::{Samples, PATCH};

#[derive(Debug, Clone)]
pub struct DatasetConfig {
    /// Longest side the frame is resampled to before feature extraction.
    /// Bounds cost per frame independently of acquisition size.
    pub working_size: u32,
    /// Patches sampled per frame per repeat.
    ///
    /// Counted in patches, not pixels: the old pixel budget divided by a
    /// patch's 2304 pixels rounded down to *one* crop per frame, which starved
    /// training so badly that any small structure was unlearnable.
    ///
    /// Kept deliberately modest because this number is expensive twice over.
    /// Every patch is materialised as dense `f32`, so the sample table costs
    /// `patches * repeats * frames * d * 2304 * 4` bytes — with an encoder
    /// attached `d` is ~410, and a value of 24 over 20 frames reaches 5 GB and
    /// starts paging. It also sets the epoch length, so it multiplies training
    /// time linearly. Raise it when a structure is genuinely hard; the local
    /// basis alone (`d` ~26) affords far more of them than an encoder does.
    pub patches_per_frame: usize,
    /// Share of patches centred on an annotated pixel rather than placed at
    /// random. Without this, minority classes never reach the loss.
    pub foreground_fraction: f32,
    /// Number of augmented passes over each frame (1 = no augmentation).
    pub repeats: usize,
    pub scribble_strokes: usize,
    pub stroke_len: usize,
    /// Probability that a repeat is built with *no* strokes at all.
    ///
    /// Training only ever with scribbles teaches the head to depend on them,
    /// and then prediction without any produces a constant channel it has
    /// never seen — a distribution shift that shows up as blank masks. Dropping
    /// them for a share of repeats forces the head to work unaided and makes
    /// scribbles a genuine refinement rather than a requirement.
    pub scribble_dropout: f32,
    /// Whether newly computed encoder features may be written to the cache.
    ///
    /// Only *writing* is ever gated — that is the act that puts derived image
    /// data on disk. Reading entries that already exist is always allowed: it
    /// costs nothing and reveals nothing new, and gating both behind one flag
    /// meant a fresh session recomputed features it had already paid for.
    ///
    /// The UI now defaults this on (users cannot tell an unticked box from a
    /// broken cache), but it stays `false` here: a `DatasetConfig` built
    /// directly, as tests do, should not write to the user's disk unasked.
    pub cache_writes: bool,
}

impl Default for DatasetConfig {
    fn default() -> Self {
        Self {
            working_size: 384,
            patches_per_frame: 8,
            foreground_fraction: 0.5,
            repeats: 3,
            scribble_strokes: 3,
            stroke_len: 40,
            scribble_dropout: 0.5,
            cache_writes: false,
        }
    }
}

/// Frames that carry at least one annotation **and** have been reviewed.
///
/// Reviewed, not merely annotated: a frame in progress is a frame whose labels
/// are wrong somewhere, and a small head fitted on a handful of images has no
/// redundancy to average that away — one half-drawn structure teaches it that
/// the structure ends there. Review is the point at which the annotator asserts
/// the frame is correct, which is exactly the guarantee training needs. It also
/// matches export, which has always defaulted to reviewed-only.
///
/// `reviewed` lives on `frames`; marking a sequence reviewed sets it on every
/// frame of that sequence, so filtering here is what "use reviewed sequences"
/// means in practice.
pub fn annotated_frame_ids(db: &DbState) -> Result<Vec<i64>, String> {
    db.with_conn(|conn| {
        // Both annotation tables: a frame drawn only with the path tool is
        // annotated, and checking just `annotations` would exclude it entirely.
        let mut stmt = conn.prepare(
            "SELECT f.id FROM frames f \
             WHERE f.reviewed = 1 \
               AND (EXISTS (SELECT 1 FROM annotations a WHERE a.frame_id = f.id) \
                 OR EXISTS (SELECT 1 FROM vector_annotations v WHERE v.frame_id = f.id)) \
             ORDER BY f.id",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        let ids = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    })
    .map_err(|e| format!("failed to list reviewed annotated frames: {e}"))
}

/// Frames that are annotated but not yet reviewed, so the UI can say what it is
/// leaving out.
///
/// Without this the model page would report "2 annotated frames" on a project
/// with forty, and the only way to discover why would be to read the source.
pub fn annotated_unreviewed_count(db: &DbState) -> Result<usize, String> {
    db.with_conn(|conn| {
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM frames f \
             WHERE f.reviewed != 1 \
               AND (EXISTS (SELECT 1 FROM annotations a WHERE a.frame_id = f.id) \
                 OR EXISTS (SELECT 1 FROM vector_annotations v WHERE v.frame_id = f.id))",
            [],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    })
    .map_err(|e| format!("failed to count unreviewed frames: {e}"))
}

/// Project label ids in display order. Class index is `position + 1`; class 0
/// is background.
pub fn label_order(db: &DbState) -> Result<Vec<i64>, String> {
    db.with_conn(|conn| {
        let mut stmt = conn.prepare("SELECT id FROM labels ORDER BY sort_order")?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        let ids = rows.collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(ids)
    })
    .map_err(|e| format!("failed to list labels: {e}"))
}

/// Nearest-neighbour downscale of a label mask.
///
/// Nearest, not averaged: interpolating class ids would invent labels that
/// never existed (the mean of class 1 and 3 is class 2).
pub fn downscale_nearest(src: &[u8], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh];
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return out;
    }
    for y in 0..dh {
        let sy = ((y as f32 + 0.5) * sh as f32 / dh as f32).floor() as usize;
        let sy = sy.min(sh - 1);
        for x in 0..dw {
            let sx = ((x as f32 + 0.5) * sw as f32 / dw as f32).floor() as usize;
            let sx = sx.min(sw - 1);
            out[y * dw + x] = src[sy * sw + sx];
        }
    }
    out
}

/// Rasterise a frame's vector shapes into per-label masks at working size.
///
/// Rasterised at native resolution and then downscaled, matching how painted
/// annotations are handled, so the two representations land on exactly the same
/// grid and a label drawn either way trains identically.
fn vector_masks(
    db: &DbState,
    frame_id: i64,
    native_w: u32,
    native_h: u32,
    w: usize,
    h: usize,
) -> Result<Vec<(i64, Vec<u8>)>, String> {
    let rows: Vec<(i64, String)> = db
        .with_conn(|conn| {
            let mut stmt =
                conn.prepare("SELECT label_id, shapes FROM vector_annotations WHERE frame_id = ?1")?;
            let it = stmt.query_map([frame_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
            Ok(it.collect::<std::result::Result<Vec<_>, _>>()?)
        })
        .map_err(|e| format!("frame {frame_id} vector annotations: {e}"))?;

    let mut out = Vec::new();
    for (label_id, json) in rows {
        // A frame whose shapes fail to parse should not sink a whole training
        // run: skip it the way an unreadable mask would be skipped.
        let Ok(shapes) = serde_json::from_str::<Vec<crate::commands::vector::VectorShape>>(&json)
        else {
            log::warn!("[ml] frame {frame_id}: unreadable vector shapes for label {label_id}, skipped");
            continue;
        };
        if shapes.is_empty() {
            continue;
        }
        let mut alpha = vec![0u8; (native_w as usize) * (native_h as usize)];
        for s in &shapes {
            crate::commands::vector::rasterize_shape(s, native_w, native_h, &mut alpha);
        }
        out.push((
            label_id,
            downscale_nearest(&alpha, native_w as usize, native_h as usize, w, h),
        ));
    }
    Ok(out)
}

/// Union vector coverage into the painted masks, per label.
///
/// Union rather than replace: a label can legitimately carry both a painted
/// region and a drawn path, and dropping either would quietly discard work the
/// annotator did.
fn merge_masks(
    mut painted: Vec<(i64, Vec<u8>)>,
    vectors: Vec<(i64, Vec<u8>)>,
) -> Vec<(i64, Vec<u8>)> {
    for (label_id, mask) in vectors {
        match painted.iter_mut().find(|(id, _)| *id == label_id) {
            Some((_, existing)) => {
                for (a, b) in existing.iter_mut().zip(mask.iter()) {
                    *a |= *b;
                }
            }
            None => painted.push((label_id, mask)),
        }
    }
    painted
}

/// Flatten per-label masks into one dense class map (0 = background).
///
/// Overlaps resolve to the earliest label in project order, matching the
/// painter's order the editor shows, so the training target agrees with what
/// the annotator sees.
pub fn combine_masks(masks: &[(i64, Vec<u8>)], order: &[i64], n_px: usize) -> Vec<i32> {
    let mut out = vec![0i32; n_px];
    for (pos, label_id) in order.iter().enumerate() {
        let Some((_, mask)) = masks.iter().find(|(id, _)| id == label_id) else {
            continue;
        };
        let class = (pos + 1) as i32;
        for i in 0..n_px.min(mask.len()) {
            if mask[i] > 0 && out[i] == 0 {
                out[i] = class;
            }
        }
    }
    out
}

/// Photometric jitter: gamma, gain and bias, applied in `[0, 1]`.
pub fn jitter(image: &Array3<f32>, rng: &mut Rng) -> Array3<f32> {
    let gamma = 0.7 + rng.unit() * 0.6; // [0.7, 1.3]
    let gain = 0.85 + rng.unit() * 0.3; // [0.85, 1.15]
    let bias = (rng.unit() - 0.5) * 0.1; // [-0.05, 0.05]
    image.mapv(|v| (v.clamp(0.0, 1.0).powf(gamma) * gain + bias).clamp(0.0, 1.0))
}

/// Draw `n_patches` patches into a sample table. Patches rather than pixels,
/// because the head is convolutional and needs neighbours.
///
/// # Class balance applies to sampling only
///
/// Crop origins are biased towards foreground. For a structure covering ~1% of
/// a frame, uniform crops put a positive pixel in front of the loss so rarely
/// that the head converges to all-background and stays there.
///
/// The bias is confined to *which crops are drawn*. Loss weighting and metrics
/// are untouched, so held-out Dice is still measured on unbalanced frames and
/// remains comparable to what the model will meet at inference. Do not extend
/// the balancing into either of those.
///
/// A frame smaller than one patch is skipped rather than padded — padding would
/// feed the head invented context it will never see at inference.
pub fn sample_patches(
    features: &Array3<f32>,
    labels: &[i32],
    n_patches: usize,
    foreground_fraction: f32,
    rng: &mut Rng,
    out: &mut Samples,
) {
    let (d, h, w) = (features.shape()[0], features.shape()[1], features.shape()[2]);
    if h < PATCH || w < PATCH || labels.len() < h * w {
        return;
    }
    let n_patches = n_patches.max(1);

    // Where the annotator actually drew. Uniform sampling alone is hopeless for
    // small structures: a target covering ~1% of a frame means most
    // random crops contain no positive pixel at all and the head converges to
    // "always background" — a correct answer to that data, and a useless model.
    // Biasing a share of crops to centre on a labelled pixel is what puts the
    // minority class in front of the loss often enough to be learned.
    let foreground: Vec<usize> = labels
        .iter()
        .enumerate()
        .filter(|(_, l)| **l > 0)
        .map(|(i, _)| i)
        .collect();
    let want_fg = if foreground.is_empty() {
        0
    } else {
        ((n_patches as f32) * foreground_fraction.clamp(0.0, 1.0)).round() as usize
    };

    let mut fbuf = vec![0.0f32; d * Samples::patch_pixels()];
    let mut lbuf = vec![0i32; Samples::patch_pixels()];
    for k in 0..n_patches {
        // Centre on a labelled pixel, clamped so the patch stays inside the
        // frame. Clamping biases towards edges for structures near a border,
        // which is preferable to discarding those examples entirely.
        let (oy, ox) = if k < want_fg {
            let p = foreground[rng.below(foreground.len())];
            let (py, px) = (p / w, p % w);
            (
                py.saturating_sub(PATCH / 2).min(h - PATCH),
                px.saturating_sub(PATCH / 2).min(w - PATCH),
            )
        } else {
            (rng.below(h - PATCH + 1), rng.below(w - PATCH + 1))
        };
        for c in 0..d {
            for py in 0..PATCH {
                for px in 0..PATCH {
                    fbuf[c * Samples::patch_pixels() + py * PATCH + px] =
                        features[[c, oy + py, ox + px]];
                }
            }
        }
        for py in 0..PATCH {
            for px in 0..PATCH {
                lbuf[py * PATCH + px] = labels[(oy + py) * w + ox + px];
            }
        }
        out.push_patch(&fbuf, &lbuf);
    }
}

/// Decode raw frame bytes into `[C, H, W]` in `[0, 1]`, preserving whether the
/// source was single-channel.
fn decode_image(bytes: &[u8]) -> Result<Array3<f32>, String> {
    let img = image::load_from_memory(bytes).map_err(|e| format!("decode failed: {e}"))?;
    let is_gray = matches!(
        img.color(),
        image::ColorType::L8 | image::ColorType::L16 | image::ColorType::La8 | image::ColorType::La16
    );
    let (w, h) = (img.width() as usize, img.height() as usize);
    if is_gray {
        let g = img.to_luma8();
        let mut out = Array3::<f32>::zeros((1, h, w));
        for y in 0..h {
            for x in 0..w {
                out[[0, y, x]] = g.get_pixel(x as u32, y as u32)[0] as f32 / 255.0;
            }
        }
        Ok(out)
    } else {
        let c = img.to_rgb8();
        let mut out = Array3::<f32>::zeros((3, h, w));
        for y in 0..h {
            for x in 0..w {
                let p = c.get_pixel(x as u32, y as u32);
                for ch in 0..3 {
                    out[[ch, y, x]] = p[ch] as f32 / 255.0;
                }
            }
        }
        Ok(out)
    }
}

/// Working-resolution size preserving aspect ratio.
fn working_dims(w: usize, h: usize, longest: u32) -> (usize, usize) {
    let longest = longest.max(16) as usize;
    if w >= h {
        let nw = longest.min(w.max(1));
        let nh = ((h as f32 * nw as f32 / w.max(1) as f32).round() as usize).max(1);
        (nw, nh)
    } else {
        let nh = longest.min(h.max(1));
        let nw = ((w as f32 * nh as f32 / h.max(1) as f32).round() as usize).max(1);
        (nw, nh)
    }
}

/// Stack feature sources into one `[D, H, W]` volume.
fn stack(parts: Vec<Array3<f32>>, h: usize, w: usize) -> Array3<f32> {
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

/// Assemble the feature volume for one frame: local basis, then optional
/// encoder channels, then the scribble distances.
///
/// **This is the single definition of channel order.** Training and inference
/// both go through it, because a head trained on one ordering and applied to
/// another fails silently — the numbers stay plausible while meaning nothing.
pub fn assemble_stack(
    image: &Array3<f32>,
    encoder_part: Option<&Array3<f32>>,
    scribbles: &scribble::Scribbles,
    fb: &FilterBankConfig,
) -> Array3<f32> {
    let (h, w) = (image.shape()[1], image.shape()[2]);
    let (local, _names) = filters::compute(image, fb);

    let ch = scribble::channels(scribbles);
    let mut scr = Array3::<f32>::zeros((SCRIBBLE_CHANNELS, h, w));
    for (c, plane) in ch.iter().enumerate() {
        for y in 0..h {
            for x in 0..w {
                scr[[c, y, x]] = plane[y * w + x];
            }
        }
    }

    let mut parts = vec![local];
    if let Some(e) = encoder_part {
        parts.push(e.clone());
    }
    parts.push(scr);
    stack(parts, h, w)
}

/// Decode a frame and resample it to working resolution.
/// Shared by training and inference so both see the same pixels.
pub fn load_working_image(
    db: &DbState,
    frame_id: i64,
    working_size: u32,
) -> Result<(Array3<f32>, usize, usize), String> {
    let (_meta, bytes) = crate::commands::frame::read_frame_bytes(db, frame_id)
        .map_err(|e| format!("frame {frame_id}: {e}"))?;
    let image = decode_image(&bytes)?;
    let (src_w, src_h) = (image.shape()[2], image.shape()[1]);
    let (w, h) = working_dims(src_w, src_h, working_size);
    Ok((resize_bilinear(&image, h, w), w, h))
}

/// The working image, from cache when possible.
///
/// Decoding a full-resolution acquisition and resampling it is pure overhead on
/// every run after the first — the result is a deterministic function of the
/// stored bytes and the working size. Keying on a hash of those *bytes* is what
/// makes the lookup possible without decoding first; the token cache keys on the
/// decoded pixels and so could never skip this step, which is why a cache
/// reporting 100% hits still spent ~15 s a frame.
///
/// Stored at full `f32` precision rather than quantised back to `u8`. Requantising
/// would make a cached run disagree with an uncached one in the low bits of every
/// filter response, and a cache that changes results is worse than a slow one.
fn working_image(
    db: &DbState,
    frame_id: i64,
    cfg: &DatasetConfig,
    feature_cache: Option<&std::path::Path>,
) -> Result<(Array3<f32>, usize, usize), String> {
    let Some(dir) = feature_cache else {
        return load_working_image(db, frame_id, cfg.working_size);
    };
    let (_meta, bytes) = crate::commands::frame::read_frame_bytes(db, frame_id)
        .map_err(|e| format!("frame {frame_id}: {e}"))?;
    let key = cache::Key::raw(cache::IMAGE_KIND, cfg.working_size, cache::hash_bytes(&bytes));
    if let Some(img) = cache::load(dir, &key) {
        if img.ndim() == 3 && img.shape()[0] == 3 {
            let (h, w) = (img.shape()[1], img.shape()[2]);
            return Ok((img, w, h));
        }
    }
    let decoded = decode_image(&bytes)?;
    let (src_w, src_h) = (decoded.shape()[2], decoded.shape()[1]);
    let (w, h) = working_dims(src_w, src_h, cfg.working_size);
    let resized = resize_bilinear(&decoded, h, w);
    if cfg.cache_writes {
        cache::store(dir, &key, &resized);
    }
    Ok((resized, w, h))
}

/// Build the sample table for one annotated frame.
pub fn build_frame_samples(
    db: &DbState,
    frame_id: i64,
    order: &[i64],
    cfg: &DatasetConfig,
    encoder: Option<&mut EncoderSession>,
    // Directory for the persistent encoder-feature cache; None skips it.
    feature_cache: Option<&std::path::Path>,
    rng: &mut Rng,
) -> Result<Samples, String> {
    // Phase timings. A single per-frame total cannot distinguish "the decode is
    // slow" from "the filter bank is slow", and guessing between them has
    // already cost more than measuring would have.
    let t_image = std::time::Instant::now();
    let (image, w, h) = working_image(db, frame_id, cfg, feature_cache)?;
    let ms_image = t_image.elapsed().as_secs_f32() * 1000.0;

    let t_labels = std::time::Instant::now();
    // Rasterise labels at native size, then downscale with nearest.
    let (native_w, native_h) = db
        .with_conn(|conn| queries::get_frame_dimensions(conn, frame_id))
        .map_err(|e| format!("frame {frame_id} dimensions: {e}"))?;
    let raw = db
        .with_conn(|conn| queries::load_annotations(conn, frame_id))
        .map_err(|e| format!("frame {frame_id} annotations: {e}"))?;
    let masks: Vec<(i64, Vec<u8>)> = raw
        .into_iter()
        .map(|a| {
            let full = decode_to_uint8(&a.mask_data, &a.encoding, native_w, native_h);
            let small = downscale_nearest(
                &full,
                native_w as usize,
                native_h as usize,
                w,
                h,
            );
            (a.label_id, small)
        })
        .collect();
    // Vector shapes are annotations too. Without this a frame labelled with the
    // path tool trains nothing at all — silently, since it still looks
    // annotated everywhere else in the app.
    let masks = merge_masks(masks, vector_masks(db, frame_id, native_w, native_h, w, h)?);
    let labels = combine_masks(&masks, order, w * h);
    let ms_labels = t_labels.elapsed().as_secs_f32() * 1000.0;

    let t_encoder = std::time::Instant::now();
    // Encoder features once per frame (see module note on reuse).
    let encoder_part = match encoder {
        Some(enc) => {
            // Cache the token grid, not the upsampled volume: tokens are about
            // a megabyte where the volume is hundreds, and re-upsampling costs
            // nothing beside a ViT forward.
            let key = feature_cache
                .map(|_| cache::Key::new(enc.encoder_id(), cfg.working_size, &image));
            let cached = match (feature_cache, &key) {
                (Some(dir), Some(k)) => cache::load(dir, k),
                _ => None,
            };
            let tokens = match cached {
                Some(t) => t,
                None => {
                    let t = enc.embed(&image)?.data;
                    if cfg.cache_writes {
                        if let (Some(dir), Some(k)) = (feature_cache, &key) {
                            cache::store(dir, k, &t);
                        }
                    }
                    t
                }
            };
            Some(resize_bilinear(&tokens, h, w))
        }
        None => None,
    };

    let ms_encoder = t_encoder.elapsed().as_secs_f32() * 1000.0;

    let n_classes_present = labels.iter().filter(|&&c| c > 0).count();
    if n_classes_present == 0 {
        // Nothing annotated at working resolution — a tiny structure can vanish
        // under downscaling. Skip rather than train on an all-background frame.
        return Ok(Samples::new(0));
    }

    let fb = FilterBankConfig::default();
    let mut out: Option<Samples> = None;
    let binary: Vec<u8> = labels.iter().map(|&c| (c > 0) as u8).collect();
    let (mut ms_stack, mut ms_sample) = (0.0f32, 0.0f32);

    for repeat in 0..cfg.repeats.max(1) {
        let view = if repeat == 0 {
            image.clone()
        } else {
            jitter(&image, rng)
        };
        // Drop the strokes entirely for a share of repeats so the head is
        // trained to stand on its own — see `scribble_dropout`.
        let unaided = cfg.scribble_dropout > 0.0 && rng.unit() < cfg.scribble_dropout;
        let s = if unaided || cfg.scribble_strokes == 0 {
            Scribbles::empty(w, h)
        } else {
            scribble::simulate(&binary, w, h, cfg.scribble_strokes, cfg.stroke_len, rng)
        };
        let t_stack = std::time::Instant::now();
        let feats = assemble_stack(&view, encoder_part.as_ref(), &s, &fb);
        ms_stack += t_stack.elapsed().as_secs_f32() * 1000.0;

        let t_sample = std::time::Instant::now();
        let acc = out.get_or_insert_with(|| Samples::new(feats.shape()[0]));
        sample_patches(
            &feats,
            &labels,
            cfg.patches_per_frame,
            cfg.foreground_fraction,
            rng,
            acc,
        );
        ms_sample += t_sample.elapsed().as_secs_f32() * 1000.0;
    }

    // `stack` and `sample` are summed over repeats, so they carry the x3 that a
    // default run pays; the others happen once per frame.
    log::info!(
        "[ml] frame {frame_id} phases — image {ms_image:.0} ms, labels {ms_labels:.0} ms, \
         encoder {ms_encoder:.0} ms, stack {ms_stack:.0} ms, sample {ms_sample:.0} ms \
         ({} repeats)",
        cfg.repeats.max(1)
    );

    Ok(out.unwrap_or_else(|| Samples::new(0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// In-memory project with frames `(id, reviewed)`; every frame gets one
    /// raster annotation unless `id` is listed in `vector_only`.
    fn project_with(frames: &[(i64, bool)], vector_only: &[i64]) -> DbState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::schema::SCHEMA).unwrap();
        conn.execute("INSERT INTO sequences (id, name) VALUES (1, 's')", [])
            .unwrap();
        for &(id, reviewed) in frames {
            conn.execute(
                "INSERT INTO frames (id, sequence_id, frame_index, width, height, reviewed)
                 VALUES (?1, 1, ?1, 8, 8, ?2)",
                rusqlite::params![id, reviewed],
            )
            .unwrap();
            // `color` is NOT NULL, and `annotations.label_id` is a foreign key —
            // a silently skipped label here fails the annotation insert instead.
            conn.execute(
                "INSERT OR IGNORE INTO labels (id, name, color) VALUES (?1, ?1, '#ffffff')",
                [id],
            )
            .unwrap();
            if vector_only.contains(&id) {
                conn.execute(
                    "INSERT INTO vector_annotations (frame_id, label_id, shapes)
                     VALUES (?1, ?1, '[]')",
                    [id],
                )
                .unwrap();
            } else {
                conn.execute(
                    "INSERT INTO annotations (frame_id, label_id, encoding, mask_data)
                     VALUES (?1, ?1, 'rle8', x'00')",
                    [id],
                )
                .unwrap();
            }
        }
        let db = DbState::new();
        db.set(conn);
        db
    }

    #[test]
    fn training_uses_reviewed_frames_only() {
        // 1 and 3 reviewed, 2 annotated but still in progress.
        let db = project_with(&[(1, true), (2, false), (3, true)], &[]);
        assert_eq!(annotated_frame_ids(&db).unwrap(), vec![1, 3]);
        assert_eq!(annotated_unreviewed_count(&db).unwrap(), 1);
    }

    #[test]
    fn a_reviewed_frame_drawn_only_with_paths_still_counts() {
        // Vector-only annotation was invisible to training once before; the
        // reviewed filter must not quietly reintroduce that.
        let db = project_with(&[(1, true), (2, true)], &[2]);
        assert_eq!(annotated_frame_ids(&db).unwrap(), vec![1, 2]);
    }

    #[test]
    fn a_reviewed_but_unannotated_frame_is_not_training_data() {
        // Reviewing an empty frame asserts "nothing here", which is not the
        // same as supervision — including it would train on a blank mask.
        let db = project_with(&[(1, true)], &[]);
        db.with_conn(|c| {
            c.execute("DELETE FROM annotations", []).unwrap();
            c.execute(
                "INSERT INTO frames (id, sequence_id, frame_index, width, height, reviewed)
                 VALUES (9, 1, 9, 8, 8, 1)",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
        assert!(annotated_frame_ids(&db).unwrap().is_empty());
        assert_eq!(annotated_unreviewed_count(&db).unwrap(), 0);
    }

    #[test]
    fn combine_respects_label_order_on_overlap() {
        // Two labels overlapping on pixel 0; the earlier one in project order
        // must win, matching what the editor renders.
        let masks = vec![(7i64, vec![1u8, 0, 1]), (9i64, vec![1u8, 1, 0])];
        let order = vec![7i64, 9];
        let out = combine_masks(&masks, &order, 3);
        assert_eq!(out, vec![1, 2, 1]);

        // Reversing project order flips the winner.
        let out = combine_masks(&masks, &vec![9i64, 7], 3);
        assert_eq!(out, vec![1, 1, 2]);
    }

    #[test]
    fn combine_ignores_labels_without_masks() {
        let masks = vec![(1i64, vec![0u8, 1])];
        let out = combine_masks(&masks, &[1, 2, 3], 2);
        assert_eq!(out, vec![0, 1]);
    }

    #[test]
    fn downscale_uses_nearest_and_never_invents_classes() {
        // Ids 1 and 3 adjacent: averaging would produce a nonexistent 2.
        let src = vec![1u8, 1, 3, 3];
        let out = downscale_nearest(&src, 4, 1, 2, 1);
        assert!(out.iter().all(|&v| v == 1 || v == 3), "got {out:?}");
        assert_eq!(downscale_nearest(&[], 0, 0, 2, 2), vec![0, 0, 0, 0]);
    }

    #[test]
    fn working_dims_preserve_aspect_and_clamp() {
        assert_eq!(working_dims(1000, 500, 100), (100, 50));
        assert_eq!(working_dims(500, 1000, 100), (50, 100));
        // Never upscales past the source on the long side.
        assert_eq!(working_dims(50, 25, 100), (50, 25));
        let (w, h) = working_dims(1, 1, 100);
        assert!(w >= 1 && h >= 1);
    }

    #[test]
    fn jitter_changes_values_but_stays_in_range() {
        let img = Array3::from_elem((3, 4, 4), 0.5);
        let mut rng = Rng::new(11);
        let j = jitter(&img, &mut rng);
        assert!(j.iter().all(|&v| (0.0..=1.0).contains(&v)));
        assert!(
            j.iter().any(|&v| (v - 0.5).abs() > 1e-4),
            "jitter had no effect"
        );
    }

    #[test]
    fn sampled_patches_keep_features_and_labels_aligned() {
        // Channel 0 encodes the flat pixel index, so a patch can be checked
        // against the labels it should have been cut from.
        let (d, h, w) = (2usize, PATCH + 6, PATCH + 9);
        let feats = Array3::from_shape_fn((d, h, w), |(c, y, x)| {
            if c == 0 { (y * w + x) as f32 } else { 0.0 }
        });
        let labels: Vec<i32> = (0..h * w).map(|i| (i % 3) as i32).collect();
        let mut out = Samples::new(d);
        sample_patches(&feats, &labels, 3, 0.0, &mut Rng::new(3), &mut out);

        assert_eq!(out.n, 3);
        assert_eq!(out.x.len(), 3 * d * Samples::patch_pixels());
        assert_eq!(out.y.len(), 3 * Samples::patch_pixels());
        for k in 0..out.n {
            let base = k * d * Samples::patch_pixels();
            for py in 0..PATCH {
                for px in 0..PATCH {
                    let idx = out.x[base + py * PATCH + px] as usize;
                    assert_eq!(
                        out.y[k * Samples::patch_pixels() + py * PATCH + px],
                        labels[idx],
                        "patch {k} pixel ({py},{px}) pairs source {idx} with the wrong label"
                    );
                }
            }
        }
    }

    /// The regression behind "every prediction is background".
    ///
    /// A tiny structure in a large frame is almost never hit by a uniform crop,
    /// so without foreground bias the sampler returns patches whose labels are
    /// entirely zero and the head has nothing to learn from.
    #[test]
    fn foreground_bias_finds_a_small_structure_that_uniform_sampling_misses() {
        let (w, h) = (200usize, 200usize);
        let feats = Array3::<f32>::zeros((2, h, w));
        // A 6x6 blob — 0.09% of the frame, the small-structure regime.
        let mut labels = vec![0i32; w * h];
        for y in 100..106 {
            for x in 100..106 {
                labels[y * w + x] = 1;
            }
        }

        let positives = |s: &Samples| s.y.iter().filter(|&&v| v > 0).count();

        let mut uniform = Samples::new(2);
        sample_patches(&feats, &labels, 16, 0.0, &mut Rng::new(5), &mut uniform);

        let mut biased = Samples::new(2);
        sample_patches(&feats, &labels, 16, 0.5, &mut Rng::new(5), &mut biased);

        assert_eq!(biased.n, 16);
        assert!(
            positives(&biased) > positives(&uniform),
            "foreground bias must surface the structure: biased={} uniform={}",
            positives(&biased),
            positives(&uniform)
        );
        assert!(
            positives(&biased) > 0,
            "no positive pixel reached the sample table at all"
        );
    }

    #[test]
    fn foreground_bias_is_harmless_when_nothing_is_labelled() {
        let feats = Array3::<f32>::zeros((2, 60, 60));
        let labels = vec![0i32; 60 * 60];
        let mut out = Samples::new(2);
        // Must not divide by zero or loop forever on an empty foreground set.
        sample_patches(&feats, &labels, 4, 1.0, &mut Rng::new(9), &mut out);
        assert_eq!(out.n, 4);
    }

    #[test]
    fn vector_coverage_unions_into_painted_masks() {
        // Same label drawn both ways: neither contribution may be lost.
        let painted = vec![(7i64, vec![1u8, 0, 0, 0])];
        let vectors = vec![(7i64, vec![0u8, 1, 0, 0])];
        let merged = merge_masks(painted, vectors);
        assert_eq!(merged.len(), 1, "one label must stay one mask");
        assert_eq!(merged[0].1, vec![1, 1, 0, 0], "coverage must union");
    }

    #[test]
    fn a_vector_only_label_becomes_its_own_mask() {
        let merged = merge_masks(vec![(1i64, vec![1u8, 0])], vec![(2i64, vec![0u8, 1])]);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|(id, m)| *id == 2 && m == &vec![0, 1]));
    }

    #[test]
    fn merging_a_vector_only_label_reaches_the_class_map() {
        // The end-to-end point of the fix: a label with no painted mask at all
        // must still produce a non-background class.
        let merged = merge_masks(Vec::new(), vec![(5i64, vec![0u8, 1, 1, 0])]);
        let classes = combine_masks(&merged, &[5], 4);
        assert_eq!(classes, vec![0, 1, 1, 0], "vector-only label must train");
    }

    #[test]
    fn sampling_skips_frames_smaller_than_a_patch() {
        // Padding would feed the head context that cannot occur at inference,
        // so an undersized frame yields nothing rather than a padded patch.
        let feats = Array3::<f32>::zeros((2, PATCH - 1, PATCH - 1));
        let labels = vec![0i32; (PATCH - 1) * (PATCH - 1)];
        let mut out = Samples::new(2);
        sample_patches(&feats, &labels, 4, 0.0, &mut Rng::new(1), &mut out);
        assert_eq!(out.n, 0);

        // A truncated label buffer is also refused.
        let big = Array3::<f32>::zeros((2, PATCH, PATCH));
        let mut out = Samples::new(2);
        sample_patches(&big, &[0, 1], 4, 0.0, &mut Rng::new(1), &mut out);
        assert_eq!(out.n, 0);
    }
}
