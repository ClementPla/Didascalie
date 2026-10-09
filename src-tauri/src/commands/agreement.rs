//! Inter-grader agreement: how closely the project's users annotated the same
//! frames.
//!
//! # What is compared
//!
//! Two graders are compared on the frames they have **both** worked on, under
//! one of two definitions ([`FrameBasis`]):
//!
//! - *Reviewed by both* — the default, and the only one that can count an
//!   empty frame. A grader who reviews a frame without drawing anything is
//!   saying "nothing here", which is an answer; a frame they have not reached
//!   yet looks identical in the data until they mark it reviewed.
//! - *Annotated by both* — for projects where nobody uses the review mark. It
//!   cannot see deliberate empties, so it overstates agreement on what was
//!   found and says nothing about what one grader found and the other did not
//!   look at.
//!
//! # The numbers
//!
//! **Segmentation**, per label. A grader's region is their painted mask plus
//! their vector shapes, binarised (instance ids are ignored: this asks whether
//! they marked the same pixels, not whether they split them the same way).
//!
//! - *Dice* and *IoU* are pooled: pixels are summed over all compared frames
//!   before dividing, so a large structure counts for more than a small one
//!   and a frame where neither drew the label does not count at all.
//! - *Mean frame Dice* averages the per-frame Dice instead, over frames where
//!   at least one of the two drew the label, so every such frame counts the
//!   same and a frame only one of them annotated scores 0.
//! - *Kappa* is Cohen's kappa on pixels (label present / absent).
//!
//! **Classification**, per task, over the same frames. No answer is treated as
//! an answer of its own.
//!
//! - One-answer tasks: percent agreement and Cohen's kappa.
//! - Several-answer tasks: agreement is the mean Jaccard index of the two
//!   selections; kappa is Cohen's kappa per class (selected / not), averaged.
//!
//! **Overall** averages the pairwise values, and adds Fleiss' kappa for
//! classification on the frames *every* participating grader has in common.
//!
//! A statistic that is undefined — nothing to compare, or no variation at all
//! in the answers, which makes chance agreement 100% — is reported as `None`
//! rather than as 0 or 1.

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::State;
use ts_rs::TS;

use crate::commands::annotation::decode_to_uint8;
use crate::commands::frame::{decode_downscaled, read_frame_bytes};
use crate::commands::users::{self, UserInfo};
use crate::commands::vector::{rasterize_shape, VectorShape};
use crate::storage::{queries, DbState};
use crate::types::image::MaskEncoding;
use crate::utils::color::parse_hex;
use crate::utils::error::Result;

// ── Types ──────────────────────────────────────────────────────────────────

/// Which frames two graders are compared on. See the module docs.
#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub enum FrameBasis {
    ReviewedByBoth,
    AnnotatedByBoth,
}

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct Grader {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    /// Frames this grader contributes under the chosen basis.
    pub frames: usize,
}

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ReportLabel {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    pub color: String,
}

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ReportTask {
    pub name: String,
    pub multilabel: bool,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct LabelAgreement {
    #[ts(type = "number")]
    pub label_id: i64,
    /// Compared frames where at least one of the two drew the label.
    pub frames: usize,
    pub dice: Option<f64>,
    pub iou: Option<f64>,
    pub mean_frame_dice: Option<f64>,
    pub kappa: Option<f64>,
    /// Pixels each grader marked, over the compared frames.
    #[ts(type = "number")]
    pub pixels_a: u64,
    #[ts(type = "number")]
    pub pixels_b: u64,
}

#[derive(Serialize, Debug, Clone, Default, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct TaskAgreement {
    pub task: String,
    /// Compared frames where at least one of the two answered.
    pub frames: usize,
    pub agreement: Option<f64>,
    pub kappa: Option<f64>,
}

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct PairAgreement {
    #[ts(type = "number")]
    pub a: i64,
    #[ts(type = "number")]
    pub b: i64,
    /// Frames both graders have under the chosen basis.
    pub frames: usize,
    pub labels: Vec<LabelAgreement>,
    pub tasks: Vec<TaskAgreement>,
    /// Mean of the defined label Dice values: one number for the pair.
    pub mean_dice: Option<f64>,
    /// Mean of the defined task kappas.
    pub mean_kappa: Option<f64>,
}

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct OverallLabel {
    #[ts(type = "number")]
    pub label_id: i64,
    /// Mean, lowest and highest pairwise Dice, over pairs where it is defined.
    pub mean_dice: Option<f64>,
    pub min_dice: Option<f64>,
    pub max_dice: Option<f64>,
    pub pairs: usize,
}

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct OverallTask {
    pub task: String,
    pub mean_kappa: Option<f64>,
    pub mean_agreement: Option<f64>,
    /// Fleiss' kappa across every participating grader at once.
    pub fleiss_kappa: Option<f64>,
}

#[derive(Serialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct AgreementReport {
    pub graders: Vec<Grader>,
    pub labels: Vec<ReportLabel>,
    pub tasks: Vec<ReportTask>,
    /// One entry per unordered pair of graders, `a` before `b` in `graders`.
    pub pairs: Vec<PairAgreement>,
    pub overall_labels: Vec<OverallLabel>,
    pub overall_tasks: Vec<OverallTask>,
    /// Frames every participating grader has in common (the Fleiss basis).
    pub frames_common_to_all: usize,
}

// ── Command ────────────────────────────────────────────────────────────────

/// Compare every pair of graders. Administrators only: seeing how one's
/// answers differ from a colleague's is exactly what independent grading is
/// meant to prevent while it is still going on.
#[tauri::command]
pub async fn intergrader_report(
    db: State<'_, DbState>,
    basis: FrameBasis,
) -> Result<AgreementReport> {
    db.with_conn(|conn| {
        users::require_admin(conn)?;
        build_report(conn, basis)
    })
}

/// One frame two graders both have, scored for one label.
#[derive(Serialize, Debug, Clone, PartialEq, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct CaseScore {
    #[ts(type = "number")]
    pub frame_id: i64,
    /// The sequence's name, with the frame number when it has several frames.
    pub name: String,
    pub dice: f64,
    #[ts(type = "number")]
    pub pixels_a: u64,
    #[ts(type = "number")]
    pub pixels_b: u64,
}

/// The frames behind one pair's score for one label, least agreement first:
/// what to look at to understand a number in the report. Frames where neither
/// grader drew the label are left out — there is nothing to see on them.
#[tauri::command]
pub async fn intergrader_cases(
    db: State<'_, DbState>,
    a: i64,
    b: i64,
    label_id: i64,
    basis: FrameBasis,
) -> Result<Vec<CaseScore>> {
    db.with_conn(|conn| {
        users::require_admin(conn)?;
        pair_cases(conn, a, b, label_id, basis)
    })
}

/// How a comparison is drawn. The defaults suit a colour photograph; on a
/// greyscale or strongly tinted modality other colours read better, and an
/// outline leaves the structure under it visible, so both are the viewer's
/// choice.
#[derive(Deserialize, Debug, Clone, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/app/lib/generated/")]
pub struct ComparisonStyle {
    /// `#rrggbb`: where only grader `a`, only grader `b`, or both marked.
    pub color_a: String,
    pub color_b: String,
    pub color_both: String,
    /// Outline thickness in pixels of the returned image; 0 fills the regions.
    pub edge_width: u32,
}

/// A frame with both graders' regions for one label drawn over it, as JPEG no
/// larger than `max_dim` on its longest side. With `overlay` false it is the
/// bare image at the same size, to see what the graders were looking at.
#[tauri::command]
pub async fn intergrader_case_image(
    db: State<'_, DbState>,
    frame_id: i64,
    a: i64,
    b: i64,
    label_id: i64,
    max_dim: u32,
    overlay: bool,
    style: ComparisonStyle,
) -> std::result::Result<Response, String> {
    let colours = Colours::parse(&style)?;
    let (meta, bytes) = read_frame_bytes(&db, frame_id).map_err(|e| e.to_string())?;
    let (width, height) = (meta.frame.width.max(0) as u32, meta.frame.height.max(0) as u32);

    let regions = if overlay {
        db.with_conn(|conn| {
            users::require_admin(conn)?;
            let rows = load_frame_rows(conn, frame_id)?;
            Ok((
                region(&rows, a, label_id, width, height),
                region(&rows, b, label_id, width, height),
            ))
        })
        .map_err(|e| e.to_string())?
    } else {
        (None, None)
    };

    // Never larger than the frame itself: enlarging adds no detail, and the
    // webview scales the picture to the page anyway.
    let longest = max_dim.min(width.max(height)).max(1);
    let image = decode_downscaled(&bytes, longest)
        .map_err(|e| e.to_string())?
        .thumbnail(longest, longest)
        .to_rgb8();
    let (out_w, out_h) = image.dimensions();
    let mut rgb = image.into_raw();
    draw_comparison(
        &mut rgb,
        out_w,
        out_h,
        regions.0.as_ref().map(|r| r.mask.as_slice()),
        regions.1.as_ref().map(|r| r.mask.as_slice()),
        width,
        height,
        &colours,
        style.edge_width as usize,
    );

    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode(&rgb, out_w, out_h, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("Failed to encode the comparison: {e}"))?;
    Ok(Response::new(out))
}

// ── Qualitative cases ──────────────────────────────────────────────────────

pub fn pair_cases(
    conn: &Connection,
    a: i64,
    b: i64,
    label_id: i64,
    basis: FrameBasis,
) -> Result<Vec<CaseScore>> {
    let set_a = frame_set(conn, a, basis)?;
    let set_b = frame_set(conn, b, basis)?;
    let mut common: Vec<i64> = set_a.intersection(&set_b).copied().collect();
    common.sort_unstable();

    let mut cases = Vec::new();
    for frame in common {
        let Some((width, height, name)) = conn
            .query_row(
                "SELECT f.width, f.height,
                        CASE WHEN (SELECT COUNT(*) FROM frames o WHERE o.sequence_id = s.id) > 1
                             THEN s.name || ' · frame ' || (f.frame_index + 1)
                             ELSE s.name END
                 FROM frames f JOIN sequences s ON s.id = f.sequence_id
                 WHERE f.id = ?1",
                params![frame],
                |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?, row.get::<_, String>(2)?)),
            )
            .ok()
        else {
            continue;
        };
        let rows = load_frame_rows(conn, frame)?;
        let mut tally = LabelTally::default();
        tally.add(
            region(&rows, a, label_id, width, height).as_ref(),
            region(&rows, b, label_id, width, height).as_ref(),
            width as u64 * height as u64,
        );
        if let Some(dice) = tally.finish(label_id).dice {
            cases.push(CaseScore {
                frame_id: frame,
                name,
                dice,
                pixels_a: tally.pixels_a,
                pixels_b: tally.pixels_b,
            });
        }
    }
    cases.sort_by(|x, y| x.dice.total_cmp(&y.dice).then(x.frame_id.cmp(&y.frame_id)));
    Ok(cases)
}

/// How strongly a filled region covers the image. Disagreement is what the eye
/// should land on, so it is nearly opaque; agreement, usually most of the
/// region, lets more of the image through. Outlines are drawn opaque: they
/// cover little, and a thin translucent line disappears.
const ALPHA_ONLY: f32 = 0.85;
const ALPHA_BOTH: f32 = 0.6;

/// The three colours of a comparison, as RGB.
struct Colours {
    only_a: [u8; 3],
    only_b: [u8; 3],
    both: [u8; 3],
}

impl Colours {
    fn parse(style: &ComparisonStyle) -> std::result::Result<Self, String> {
        Ok(Self {
            only_a: parse_hex(&style.color_a)?,
            only_b: parse_hex(&style.color_b)?,
            both: parse_hex(&style.color_both)?,
        })
    }
}

/// Keep only the outline, `width` pixels thick, of the region carrying `bit`.
///
/// A marked pixel is outline when an unmarked pixel lies within `width` of it
/// along a row or a column — i.e. the region minus its erosion by a square.
/// The image border does not count as unmarked: a region running off the frame
/// is not closed along the edge of the picture, because the grader did not
/// draw a boundary there.
fn keep_outline(marks: &mut [u8], ow: usize, oh: usize, bit: u8, width: usize) {
    // Erode along rows, then along columns of that result.
    let inside: Vec<bool> = marks.iter().map(|m| m & bit != 0).collect();
    let mut rows = vec![false; ow * oh];
    for y in 0..oh {
        let line = &inside[y * ow..(y + 1) * ow];
        for x in 0..ow {
            let (from, to) = (x.saturating_sub(width), (x + width).min(ow - 1));
            rows[y * ow + x] = line[from..=to].iter().all(|v| *v);
        }
    }
    for y in 0..oh {
        let (from, to) = (y.saturating_sub(width), (y + width).min(oh - 1));
        for x in 0..ow {
            let core = (from..=to).all(|yy| rows[yy * ow + x]);
            if core {
                marks[y * ow + x] &= !bit;
            }
        }
    }
}

/// Blend two graders' regions (native `width×height` masks) over an
/// `out_w×out_h` RGB image.
///
/// A preview pixel is marked when *any* native pixel it covers is: sampling one
/// native pixel per preview pixel instead would drop most of a thin structure
/// — a one-pixel vessel on a 4000-pixel image — and show disagreement where
/// there is only a missing sample.
fn draw_comparison(
    rgb: &mut [u8],
    out_w: u32,
    out_h: u32,
    a: Option<&[u8]>,
    b: Option<&[u8]>,
    width: u32,
    height: u32,
    colours: &Colours,
    edge_width: usize,
) {
    let (w, h, ow, oh) = (width as usize, height as usize, out_w as usize, out_h as usize);
    if w == 0 || h == 0 || ow == 0 || oh == 0 || (a.is_none() && b.is_none()) {
        return;
    }
    // The native pixels each preview column / row covers: at least one, so
    // this also holds when the preview is *larger* than the frame. Walking the
    // native pixels and marking where each lands does not — enlarged, most
    // preview pixels are nobody's landing spot, and the region comes out as a
    // grid of marked and unmarked lines.
    let span = |out: usize, native: usize, i: usize| {
        let start = (i * native / out).min(native - 1);
        start..((i + 1) * native / out).clamp(start + 1, native)
    };
    let columns: Vec<_> = (0..ow).map(|x| span(ow, w, x)).collect();

    let mut marks = vec![0u8; ow * oh];
    for (bit, mask) in [(1u8, a), (2u8, b)] {
        let Some(mask) = mask.filter(|m| m.len() >= w * h) else { continue };
        for (oy, out_row) in marks.chunks_exact_mut(ow).enumerate() {
            for y in span(oh, h, oy) {
                let row = &mask[y * w..(y + 1) * w];
                for (mark, xs) in out_row.iter_mut().zip(&columns) {
                    if row[xs.clone()].iter().any(|v| *v != 0) {
                        *mark |= bit;
                    }
                }
            }
        }
    }
    // Outlines are taken per grader, before the two are combined, so each
    // keeps its own contour in its own colour; where the two contours run
    // together the pixel carries both bits and takes the "both" colour.
    if edge_width > 0 {
        keep_outline(&mut marks, ow, oh, 1, edge_width);
        keep_outline(&mut marks, ow, oh, 2, edge_width);
    }
    let (only, both) = if edge_width > 0 { (1.0, 1.0) } else { (ALPHA_ONLY, ALPHA_BOTH) };

    for (pixel, mark) in rgb.chunks_exact_mut(3).zip(&marks) {
        let (colour, alpha) = match mark {
            1 => (colours.only_a, only),
            2 => (colours.only_b, only),
            3 => (colours.both, both),
            _ => continue,
        };
        for (channel, target) in pixel.iter_mut().zip(colour) {
            *channel = (*channel as f32 * (1.0 - alpha) + target as f32 * alpha).round() as u8;
        }
    }
}

// ── Statistics ─────────────────────────────────────────────────────────────

fn ratio(num: f64, den: f64) -> Option<f64> {
    (den > 0.0).then(|| num / den)
}

fn mean(values: impl Iterator<Item = f64>) -> Option<f64> {
    let (sum, n) = values.fold((0.0, 0usize), |(s, n), v| (s + v, n + 1));
    (n > 0).then(|| sum / n as f64)
}

/// Kappa from observed and chance agreement; undefined when chance agreement
/// is total (every answer identical, so there is nothing to beat).
fn kappa(observed: f64, expected: f64) -> Option<f64> {
    ((1.0 - expected) > 1e-12).then(|| (observed - expected) / (1.0 - expected))
}

/// Cohen's kappa for a yes/no judgement, from the four cells of its table.
fn binary_kappa(both: u64, only_a: u64, only_b: u64, neither: u64) -> Option<f64> {
    let n = (both + only_a + only_b + neither) as f64;
    if n == 0.0 {
        return None;
    }
    let a = (both + only_a) as f64 / n;
    let b = (both + only_b) as f64 / n;
    kappa((both + neither) as f64 / n, a * b + (1.0 - a) * (1.0 - b))
}

/// Percent agreement and Cohen's kappa for paired categorical answers.
fn cohen(pairs: &[(&str, &str)]) -> (Option<f64>, Option<f64>) {
    let n = pairs.len() as f64;
    if pairs.is_empty() {
        return (None, None);
    }
    let mut a_counts: HashMap<&str, f64> = HashMap::new();
    let mut b_counts: HashMap<&str, f64> = HashMap::new();
    let mut same = 0.0;
    for (a, b) in pairs {
        *a_counts.entry(a).or_default() += 1.0;
        *b_counts.entry(b).or_default() += 1.0;
        if a == b {
            same += 1.0;
        }
    }
    let expected: f64 = a_counts
        .iter()
        .map(|(category, count)| count / n * b_counts.get(category).copied().unwrap_or(0.0) / n)
        .sum();
    (Some(same / n), kappa(same / n, expected))
}

/// Fleiss' kappa. `ratings[subject]` holds one category per rater; every
/// subject must have the same number of raters (at least two).
fn fleiss(ratings: &[Vec<&str>]) -> Option<f64> {
    let raters = ratings.first()?.len();
    if raters < 2 {
        return None;
    }
    let n = raters as f64;
    let mut totals: HashMap<&str, f64> = HashMap::new();
    let mut observed = 0.0;
    for subject in ratings {
        let mut counts: HashMap<&str, f64> = HashMap::new();
        for category in subject {
            *counts.entry(category).or_default() += 1.0;
        }
        observed += (counts.values().map(|c| c * c).sum::<f64>() - n) / (n * (n - 1.0));
        for (category, count) in counts {
            *totals.entry(category).or_default() += count;
        }
    }
    let subjects = ratings.len() as f64;
    let expected: f64 = totals.values().map(|t| (t / (subjects * n)).powi(2)).sum();
    kappa(observed / subjects, expected)
}

// ── Segmentation ───────────────────────────────────────────────────────────

/// Running totals for one label between two graders.
#[derive(Default, Clone)]
struct LabelTally {
    intersection: u64,
    pixels_a: u64,
    pixels_b: u64,
    /// Pixels looked at, for the pixel-level kappa.
    pixels: u64,
    frame_dice_sum: f64,
    frames: usize,
}

impl LabelTally {
    fn add(&mut self, a: Option<&Region>, b: Option<&Region>, frame_pixels: u64) {
        let count_a = a.map_or(0, |r| r.count);
        let count_b = b.map_or(0, |r| r.count);
        let intersection = match (a, b) {
            (Some(a), Some(b)) if count_a > 0 && count_b > 0 => {
                a.mask.iter().zip(&b.mask).filter(|(x, y)| **x != 0 && **y != 0).count() as u64
            }
            _ => 0,
        };
        self.intersection += intersection;
        self.pixels_a += count_a;
        self.pixels_b += count_b;
        self.pixels += frame_pixels;
        if count_a + count_b > 0 {
            self.frames += 1;
            self.frame_dice_sum += 2.0 * intersection as f64 / (count_a + count_b) as f64;
        }
    }

    fn finish(&self, label_id: i64) -> LabelAgreement {
        let (i, a, b) = (self.intersection, self.pixels_a, self.pixels_b);
        LabelAgreement {
            label_id,
            frames: self.frames,
            dice: ratio(2.0 * i as f64, (a + b) as f64),
            iou: ratio(i as f64, (a + b - i) as f64),
            mean_frame_dice: ratio(self.frame_dice_sum, self.frames as f64),
            kappa: binary_kappa(i, a - i, b - i, self.pixels.saturating_sub(a + b - i)),
            pixels_a: a,
            pixels_b: b,
        }
    }
}

/// Where one grader marked one label on one frame.
struct Region {
    /// `width * height`, non-zero where marked.
    mask: Vec<u8>,
    count: u64,
}

/// Everything every user stored for one frame, still encoded: decoding is
/// deferred to the label being compared so only one label's masks are in
/// memory at a time, which matters on very large images.
struct FrameRows {
    /// (user, label) -> painted mask
    raster: HashMap<(i64, i64), (MaskEncoding, Vec<u8>)>,
    /// (user, label) -> shapes JSON
    vector: HashMap<(i64, i64), String>,
}

fn load_frame_rows(conn: &Connection, frame_id: i64) -> Result<FrameRows> {
    let mut raster = HashMap::new();
    let mut stmt = conn.prepare_cached(
        "SELECT user_id, label_id, encoding, mask_data FROM main.annotations WHERE frame_id = ?1",
    )?;
    let rows = stmt.query_map(params![frame_id], |row| {
        Ok((
            (row.get::<_, i64>(0)?, row.get::<_, i64>(1)?),
            (MaskEncoding::from_str(&row.get::<_, String>(2)?), row.get::<_, Vec<u8>>(3)?),
        ))
    })?;
    for row in rows {
        let (key, value) = row?;
        raster.insert(key, value);
    }

    let mut vector = HashMap::new();
    let mut stmt = conn.prepare_cached(
        "SELECT user_id, label_id, shapes FROM main.vector_annotations WHERE frame_id = ?1",
    )?;
    let rows = stmt.query_map(params![frame_id], |row| {
        Ok(((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?), row.get::<_, String>(2)?))
    })?;
    for row in rows {
        let (key, value) = row?;
        vector.insert(key, value);
    }
    Ok(FrameRows { raster, vector })
}

/// One grader's region for one label: painted mask united with drawn shapes.
/// `None` when they stored nothing for it.
fn region(rows: &FrameRows, user: i64, label: i64, width: u32, height: u32) -> Option<Region> {
    let key = (user, label);
    let painted = rows.raster.get(&key);
    // Shapes that fail to parse are skipped, as training and export do: one
    // unreadable row should not sink the whole report.
    let shapes: Vec<VectorShape> = rows
        .vector
        .get(&key)
        .and_then(|json| serde_json::from_str(json).ok())
        .unwrap_or_default();
    if painted.is_none() && shapes.is_empty() {
        return None;
    }

    let mut mask = match painted {
        Some((encoding, data)) => decode_to_uint8(data, encoding, width, height),
        None => vec![0u8; width as usize * height as usize],
    };
    for shape in &shapes {
        rasterize_shape(shape, width, height, &mut mask);
    }
    let count = mask.iter().filter(|v| **v != 0).count() as u64;
    Some(Region { mask, count })
}

// ── Classification ─────────────────────────────────────────────────────────

/// The answer stored when a grader gave none.
const NO_ANSWER: &str = "";

/// (user, frame, task) -> selected classes, for every user.
type Answers = HashMap<(i64, i64, String), Vec<String>>;

fn load_answers(conn: &Connection) -> Result<Answers> {
    let mut stmt = conn.prepare(
        "SELECT user_id, frame_id, task_name, selected_classes FROM main.classifications",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    let mut answers = Answers::new();
    for row in rows {
        let (user, frame, task, json) = row?;
        let classes: Vec<String> = serde_json::from_str(&json).unwrap_or_default();
        answers.insert((user, frame, task), classes);
    }
    Ok(answers)
}

struct Task {
    name: String,
    classes: Vec<String>,
    multilabel: bool,
}

fn selected<'a>(answers: &'a Answers, user: i64, frame: i64, task: &str) -> &'a [String] {
    answers.get(&(user, frame, task.to_string())).map_or(&[], |v| v.as_slice())
}

fn single<'a>(answers: &'a Answers, user: i64, frame: i64, task: &str) -> &'a str {
    selected(answers, user, frame, task).first().map_or(NO_ANSWER, |s| s.as_str())
}

fn task_agreement(answers: &Answers, task: &Task, a: i64, b: i64, frames: &[i64]) -> TaskAgreement {
    let answered = frames
        .iter()
        .filter(|f| {
            !selected(answers, a, **f, &task.name).is_empty()
                || !selected(answers, b, **f, &task.name).is_empty()
        })
        .count();

    let (agreement, kappa) = if !task.multilabel {
        let pairs: Vec<(&str, &str)> = frames
            .iter()
            .map(|f| (single(answers, a, *f, &task.name), single(answers, b, *f, &task.name)))
            .collect();
        cohen(&pairs)
    } else {
        // Agreement: how much the two selections overlap, frame by frame. Two
        // empty selections agree completely.
        let jaccard = mean(frames.iter().map(|f| {
            let sa: HashSet<&String> = selected(answers, a, *f, &task.name).iter().collect();
            let sb: HashSet<&String> = selected(answers, b, *f, &task.name).iter().collect();
            let union = sa.union(&sb).count();
            if union == 0 {
                1.0
            } else {
                sa.intersection(&sb).count() as f64 / union as f64
            }
        }));
        // Kappa: each class is its own yes/no question.
        let per_class = task.classes.iter().filter_map(|class| {
            let (mut both, mut only_a, mut only_b, mut neither) = (0, 0, 0, 0);
            for f in frames {
                let in_a = selected(answers, a, *f, &task.name).contains(class);
                let in_b = selected(answers, b, *f, &task.name).contains(class);
                match (in_a, in_b) {
                    (true, true) => both += 1,
                    (true, false) => only_a += 1,
                    (false, true) => only_b += 1,
                    (false, false) => neither += 1,
                }
            }
            binary_kappa(both, only_a, only_b, neither)
        });
        (jaccard, mean(per_class))
    };

    TaskAgreement { task: task.name.clone(), frames: answered, agreement, kappa }
}

fn task_fleiss(answers: &Answers, task: &Task, raters: &[i64], frames: &[i64]) -> Option<f64> {
    if frames.is_empty() {
        return None;
    }
    if !task.multilabel {
        let ratings: Vec<Vec<&str>> = frames
            .iter()
            .map(|f| raters.iter().map(|u| single(answers, *u, *f, &task.name)).collect())
            .collect();
        return fleiss(&ratings);
    }
    mean(task.classes.iter().filter_map(|class| {
        let ratings: Vec<Vec<&str>> = frames
            .iter()
            .map(|f| {
                raters
                    .iter()
                    .map(|u| {
                        if selected(answers, *u, *f, &task.name).contains(class) {
                            "yes"
                        } else {
                            "no"
                        }
                    })
                    .collect()
            })
            .collect();
        fleiss(&ratings)
    }))
}

// ── Report ─────────────────────────────────────────────────────────────────

fn frame_set(conn: &Connection, user: i64, basis: FrameBasis) -> Result<HashSet<i64>> {
    let sql = match basis {
        FrameBasis::ReviewedByBoth => "SELECT frame_id FROM main.frame_reviews WHERE user_id = ?1",
        FrameBasis::AnnotatedByBoth => {
            "SELECT frame_id FROM main.annotations WHERE user_id = ?1
             UNION SELECT frame_id FROM main.vector_annotations WHERE user_id = ?1
             UNION SELECT frame_id FROM main.classifications WHERE user_id = ?1"
        }
    };
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params![user], |row| row.get(0))?;
    Ok(rows.collect::<std::result::Result<_, _>>()?)
}

pub fn build_report(conn: &Connection, basis: FrameBasis) -> Result<AgreementReport> {
    let accounts: Vec<UserInfo> = users::all_users(conn)?;
    let sets: Vec<HashSet<i64>> = accounts
        .iter()
        .map(|u| frame_set(conn, u.id, basis))
        .collect::<Result<_>>()?;

    let labels: Vec<ReportLabel> = {
        let mut stmt = conn.prepare("SELECT id, name, color FROM labels ORDER BY sort_order, id")?;
        let rows = stmt.query_map([], |row| {
            Ok(ReportLabel { id: row.get(0)?, name: row.get(1)?, color: row.get(2)? })
        })?;
        rows.collect::<std::result::Result<_, _>>()?
    };

    let config = queries::get_project_config(conn)?;
    let mut tasks: Vec<Task> = config
        .classification_tasks
        .unwrap_or_default()
        .into_iter()
        .map(|t| Task { name: t.name, classes: t.classes, multilabel: false })
        .collect();
    if let Some(t) = config.multilabel_task {
        tasks.push(Task { name: t.name, classes: t.classes, multilabel: true });
    }

    // Every unordered pair, as indices into `accounts`.
    let pair_indices: Vec<(usize, usize)> = (0..accounts.len())
        .flat_map(|i| (i + 1..accounts.len()).map(move |j| (i, j)))
        .collect();

    // ---- Segmentation: one pass over the frames at least two graders share.
    let mut tallies: Vec<Vec<LabelTally>> =
        vec![vec![LabelTally::default(); labels.len()]; pair_indices.len()];

    let mut shared: Vec<i64> = {
        let mut seen: HashMap<i64, usize> = HashMap::new();
        for set in &sets {
            for frame in set {
                *seen.entry(*frame).or_default() += 1;
            }
        }
        seen.into_iter().filter(|(_, n)| *n >= 2).map(|(f, _)| f).collect()
    };
    shared.sort_unstable();

    if !labels.is_empty() {
        for &frame in &shared {
            let Some((width, height)) = conn
                .query_row(
                    "SELECT width, height FROM frames WHERE id = ?1",
                    params![frame],
                    |row| Ok((row.get::<_, u32>(0)?, row.get::<_, u32>(1)?)),
                )
                .ok()
            else {
                continue;
            };
            let rows = load_frame_rows(conn, frame)?;
            let frame_pixels = width as u64 * height as u64;

            for (l, label) in labels.iter().enumerate() {
                // Decode each participating grader's region once per label.
                let regions: Vec<Option<Region>> = accounts
                    .iter()
                    .zip(&sets)
                    .map(|(user, set)| {
                        set.contains(&frame)
                            .then(|| region(&rows, user.id, label.id, width, height))
                            .flatten()
                    })
                    .collect();
                for (p, &(i, j)) in pair_indices.iter().enumerate() {
                    if sets[i].contains(&frame) && sets[j].contains(&frame) {
                        tallies[p][l].add(regions[i].as_ref(), regions[j].as_ref(), frame_pixels);
                    }
                }
            }
        }
    }

    // ---- Classification, and assembling each pair.
    let answers = load_answers(conn)?;
    let mut pairs = Vec::with_capacity(pair_indices.len());
    for (p, &(i, j)) in pair_indices.iter().enumerate() {
        let mut common: Vec<i64> = sets[i].intersection(&sets[j]).copied().collect();
        common.sort_unstable();

        let label_stats: Vec<LabelAgreement> =
            labels.iter().enumerate().map(|(l, label)| tallies[p][l].finish(label.id)).collect();
        let task_stats: Vec<TaskAgreement> = tasks
            .iter()
            .map(|t| task_agreement(&answers, t, accounts[i].id, accounts[j].id, &common))
            .collect();

        pairs.push(PairAgreement {
            a: accounts[i].id,
            b: accounts[j].id,
            frames: common.len(),
            mean_dice: mean(label_stats.iter().filter_map(|s| s.dice)),
            mean_kappa: mean(task_stats.iter().filter_map(|s| s.kappa)),
            labels: label_stats,
            tasks: task_stats,
        });
    }

    // ---- Overall.
    let overall_labels = labels
        .iter()
        .enumerate()
        .map(|(l, label)| {
            let dice: Vec<f64> = pairs.iter().filter_map(|p| p.labels[l].dice).collect();
            OverallLabel {
                label_id: label.id,
                mean_dice: mean(dice.iter().copied()),
                min_dice: dice.iter().copied().reduce(f64::min),
                max_dice: dice.iter().copied().reduce(f64::max),
                pairs: dice.len(),
            }
        })
        .collect();

    // Fleiss needs the same raters on every subject: the graders who took
    // part at all, on the frames all of them have.
    let participating: Vec<usize> = (0..accounts.len()).filter(|i| !sets[*i].is_empty()).collect();
    let raters: Vec<i64> = participating.iter().map(|i| accounts[*i].id).collect();
    let mut common_to_all: Vec<i64> = match participating.split_first() {
        Some((first, rest)) if !rest.is_empty() => sets[*first]
            .iter()
            .filter(|f| rest.iter().all(|i| sets[*i].contains(f)))
            .copied()
            .collect(),
        _ => Vec::new(),
    };
    common_to_all.sort_unstable();

    let overall_tasks = tasks
        .iter()
        .enumerate()
        .map(|(t, task)| OverallTask {
            task: task.name.clone(),
            mean_kappa: mean(pairs.iter().filter_map(|p| p.tasks[t].kappa)),
            mean_agreement: mean(pairs.iter().filter_map(|p| p.tasks[t].agreement)),
            fleiss_kappa: task_fleiss(&answers, task, &raters, &common_to_all),
        })
        .collect();

    Ok(AgreementReport {
        graders: accounts
            .iter()
            .zip(&sets)
            .map(|(u, set)| Grader { id: u.id, name: u.name.clone(), frames: set.len() })
            .collect(),
        labels,
        tasks: tasks
            .iter()
            .map(|t| ReportTask { name: t.name.clone(), multilabel: t.multilabel })
            .collect(),
        pairs,
        overall_labels,
        overall_tasks,
        frames_common_to_all: common_to_all.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::rle;
    use crate::types::project::{MulticlassConfig, MultilabelConfig, ProjectConfig};
    use std::path::Path;

    fn close(a: Option<f64>, b: f64) -> bool {
        a.is_some_and(|a| (a - b).abs() < 1e-9)
    }

    /// Two graders (1 = Admin, 2 = Anna), three 2×2 frames, one label, one
    /// one-answer task and one several-answer task.
    fn project() -> Connection {
        let conn = queries::create_database(Path::new(":memory:")).unwrap();
        let config = ProjectConfig {
            name: "p".into(),
            classification_tasks: Some(vec![MulticlassConfig {
                name: "quality".into(),
                classes: vec!["good".into(), "bad".into()],
                default: None,
            }]),
            multilabel_task: Some(MultilabelConfig {
                name: "findings".into(),
                classes: vec!["x".into(), "y".into()],
                default: None,
            }),
            ..Default::default()
        };
        queries::insert_project(&conn, &config).unwrap();
        conn.execute_batch(
            "INSERT INTO users (id, name) VALUES (2, 'Anna');
             INSERT INTO labels (id, name, color) VALUES (1, 'cell', '#ff0000');
             INSERT INTO sequences (id, name) VALUES (1, 's');
             INSERT INTO frames (id, sequence_id, frame_index, width, height)
               VALUES (1, 1, 0, 2, 2), (2, 1, 1, 2, 2), (3, 1, 2, 2, 2);",
        )
        .unwrap();
        conn
    }

    fn paint(conn: &Connection, user: i64, frame: i64, mask: [u8; 4]) {
        conn.execute(
            "INSERT INTO annotations (frame_id, label_id, user_id, encoding, mask_data)
             VALUES (?1, 1, ?2, 'rle8', ?3)",
            params![frame, user, rle::encode8(&mask)],
        )
        .unwrap();
    }

    fn review(conn: &Connection, user: i64, frames: &[i64]) {
        for f in frames {
            conn.execute(
                "INSERT INTO frame_reviews (frame_id, user_id) VALUES (?1, ?2)",
                params![f, user],
            )
            .unwrap();
        }
    }

    fn answer(conn: &Connection, user: i64, frame: i64, task: &str, classes: &str) {
        conn.execute(
            "INSERT INTO classifications (frame_id, user_id, task_name, selected_classes)
             VALUES (?1, ?2, ?3, ?4)",
            params![frame, user, task, classes],
        )
        .unwrap();
    }

    #[test]
    fn dice_iou_and_pixel_kappa_on_a_known_overlap() {
        let conn = project();
        review(&conn, 1, &[1]);
        review(&conn, 2, &[1]);
        paint(&conn, 1, 1, [1, 1, 0, 0]);
        paint(&conn, 2, 1, [1, 0, 0, 0]);

        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        assert_eq!(report.pairs.len(), 1);
        let pair = &report.pairs[0];
        assert_eq!((pair.a, pair.b, pair.frames), (1, 2, 1));

        // |A| = 2, |B| = 1, |A∩B| = 1 over 4 pixels.
        let cell = &pair.labels[0];
        assert!(close(cell.dice, 2.0 / 3.0));
        assert!(close(cell.iou, 0.5));
        assert!(close(cell.mean_frame_dice, 2.0 / 3.0));
        // Observed 3/4; chance (2·1 + 2·3)/16 = 1/2.
        assert!(close(cell.kappa, 0.5));
        assert_eq!((cell.pixels_a, cell.pixels_b, cell.frames), (2, 1, 1));
        assert!(close(report.overall_labels[0].mean_dice, 2.0 / 3.0));
    }

    #[test]
    fn instance_ids_are_ignored_and_shapes_count_as_marked_pixels() {
        let conn = project();
        review(&conn, 1, &[1]);
        review(&conn, 2, &[1]);
        // Same pixels, split into two instances by one grader only.
        paint(&conn, 1, 1, [1, 2, 0, 0]);
        // The other drew the top row as a filled rectangle instead.
        let shape = r#"[{"id":"s","labelId":1,"closed":true,"filled":true,"nodes":[
            {"x":0,"y":0,"inX":0,"inY":0,"outX":0,"outY":0,"smooth":false},
            {"x":2,"y":0,"inX":2,"inY":0,"outX":2,"outY":0,"smooth":false},
            {"x":2,"y":1,"inX":2,"inY":1,"outX":2,"outY":1,"smooth":false},
            {"x":0,"y":1,"inX":0,"inY":1,"outX":0,"outY":1,"smooth":false}]}]"#;
        conn.execute(
            "INSERT INTO vector_annotations (frame_id, label_id, user_id, shapes)
             VALUES (1, 1, 2, ?1)",
            params![shape],
        )
        .unwrap();

        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        assert!(close(report.pairs[0].labels[0].dice, 1.0));
    }

    /// The reason "reviewed by both" is the default.
    #[test]
    fn a_frame_one_grader_left_empty_on_purpose_counts_against_agreement() {
        let conn = project();
        review(&conn, 1, &[1, 2]);
        review(&conn, 2, &[1, 2]);
        paint(&conn, 1, 1, [1, 1, 0, 0]);
        paint(&conn, 2, 1, [1, 1, 0, 0]);
        paint(&conn, 1, 2, [1, 1, 1, 1]); // Anna reviewed frame 2 and drew nothing.

        let reviewed = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        let cell = &reviewed.pairs[0].labels[0];
        assert_eq!(reviewed.pairs[0].frames, 2);
        assert!(close(cell.dice, 2.0 * 2.0 / 8.0), "pooled over both frames");
        assert!(close(cell.mean_frame_dice, 0.5), "one perfect frame, one missed");

        // Under "annotated by both" frame 2 is not a shared frame at all.
        let annotated = build_report(&conn, FrameBasis::AnnotatedByBoth).unwrap();
        assert_eq!(annotated.pairs[0].frames, 1);
        assert!(close(annotated.pairs[0].labels[0].dice, 1.0));
    }

    #[test]
    fn frames_only_one_grader_has_are_not_compared() {
        let conn = project();
        review(&conn, 1, &[1, 2, 3]);
        review(&conn, 2, &[3]);
        paint(&conn, 1, 1, [1, 1, 1, 1]);
        paint(&conn, 1, 3, [1, 0, 0, 0]);
        paint(&conn, 2, 3, [1, 0, 0, 0]);

        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        assert_eq!(report.pairs[0].frames, 1);
        assert!(close(report.pairs[0].labels[0].dice, 1.0));
        assert_eq!(report.graders.iter().map(|g| g.frames).collect::<Vec<_>>(), [3, 1]);
    }

    #[test]
    fn nothing_in_common_is_undefined_not_zero() {
        let conn = project();
        review(&conn, 1, &[1]);
        review(&conn, 2, &[2]);
        paint(&conn, 1, 1, [1, 1, 1, 1]);
        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        let pair = &report.pairs[0];
        assert_eq!(pair.frames, 0);
        assert_eq!(pair.labels[0].dice, None);
        assert_eq!(pair.tasks[0].kappa, None);
        assert_eq!(pair.mean_dice, None);
        assert_eq!(report.overall_labels[0].pairs, 0);
    }

    #[test]
    fn cohens_kappa_for_a_one_answer_task() {
        let conn = project();
        review(&conn, 1, &[1, 2]);
        review(&conn, 2, &[1, 2]);
        answer(&conn, 1, 1, "quality", r#"["good"]"#);
        answer(&conn, 1, 2, "quality", r#"["bad"]"#);
        answer(&conn, 2, 1, "quality", r#"["good"]"#);
        answer(&conn, 2, 2, "quality", r#"["good"]"#);

        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        let quality = &report.pairs[0].tasks[0];
        assert!(close(quality.agreement, 0.5));
        // Chance: P(good,good) = 0.5·1, P(bad,bad) = 0.5·0.
        assert!(close(quality.kappa, 0.0));
        assert_eq!(quality.frames, 2);
    }

    #[test]
    fn identical_answers_agree_fully_and_leave_kappa_undefined() {
        let conn = project();
        review(&conn, 1, &[1, 2]);
        review(&conn, 2, &[1, 2]);
        for user in [1, 2] {
            for frame in [1, 2] {
                answer(&conn, user, frame, "quality", r#"["good"]"#);
            }
        }
        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        let quality = &report.pairs[0].tasks[0];
        assert!(close(quality.agreement, 1.0));
        assert_eq!(quality.kappa, None, "no variation, so no chance level to beat");
    }

    #[test]
    fn a_missing_answer_is_a_disagreement_with_a_given_one() {
        let conn = project();
        review(&conn, 1, &[1, 2]);
        review(&conn, 2, &[1, 2]);
        answer(&conn, 1, 1, "quality", r#"["good"]"#);
        answer(&conn, 1, 2, "quality", r#"["bad"]"#);
        answer(&conn, 2, 1, "quality", r#"["good"]"#);
        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        assert!(close(report.pairs[0].tasks[0].agreement, 0.5));
    }

    #[test]
    fn a_several_answer_task_uses_jaccard_and_per_class_kappa() {
        let conn = project();
        review(&conn, 1, &[1, 2]);
        review(&conn, 2, &[1, 2]);
        answer(&conn, 1, 1, "findings", r#"["x","y"]"#);
        answer(&conn, 2, 1, "findings", r#"["x"]"#);
        // Frame 2: neither selected anything.

        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        let findings = &report.pairs[0].tasks[1];
        assert!(close(findings.agreement, (0.5 + 1.0) / 2.0));
        // x: both agree on both frames, with variation -> 1.
        // y: A yes/no, B no/no -> observed 0.5, chance 0.5 -> 0.
        assert!(close(findings.kappa, 0.5));
        assert_eq!(findings.frames, 1);
    }

    #[test]
    fn three_graders_give_three_pairs_and_a_fleiss_kappa() {
        let conn = project();
        conn.execute("INSERT INTO users (id, name) VALUES (3, 'Ben')", []).unwrap();
        for user in [1, 2, 3] {
            review(&conn, user, &[1, 2]);
        }
        // Frame 1: unanimous "good". Frame 2: unanimous "bad".
        for user in [1, 2, 3] {
            answer(&conn, user, 1, "quality", r#"["good"]"#);
            answer(&conn, user, 2, "quality", r#"["bad"]"#);
        }
        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        assert_eq!(report.pairs.len(), 3);
        assert_eq!(report.frames_common_to_all, 2);
        assert!(close(report.overall_tasks[0].fleiss_kappa, 1.0));
        assert!(close(report.overall_tasks[0].mean_kappa, 1.0));
    }

    /// The textbook example (Fleiss 1971, as tabulated on Wikipedia): 10
    /// subjects, 14 raters, 5 categories, kappa = 0.210.
    #[test]
    fn fleiss_matches_the_reference_example() {
        let table: [[usize; 5]; 10] = [
            [0, 0, 0, 0, 14],
            [0, 2, 6, 4, 2],
            [0, 0, 3, 5, 6],
            [0, 3, 9, 2, 0],
            [2, 2, 8, 1, 1],
            [7, 7, 0, 0, 0],
            [3, 2, 6, 3, 0],
            [2, 5, 3, 2, 2],
            [6, 5, 2, 1, 0],
            [0, 2, 2, 3, 7],
        ];
        let names = ["1", "2", "3", "4", "5"];
        let ratings: Vec<Vec<&str>> = table
            .iter()
            .map(|row| {
                row.iter()
                    .enumerate()
                    .flat_map(|(c, n)| std::iter::repeat(names[c]).take(*n))
                    .collect()
            })
            .collect();
        let k = fleiss(&ratings).unwrap();
        assert!((k - 0.210).abs() < 0.001, "got {k}");
    }

    #[test]
    fn cases_come_worst_first_and_skip_frames_neither_drew_on() {
        let conn = project();
        review(&conn, 1, &[1, 2, 3]);
        review(&conn, 2, &[1, 2, 3]);
        paint(&conn, 1, 1, [1, 1, 0, 0]); // frame 1: identical
        paint(&conn, 2, 1, [1, 1, 0, 0]);
        paint(&conn, 1, 2, [1, 1, 0, 0]); // frame 2: half overlap
        paint(&conn, 2, 2, [0, 1, 1, 0]);
        // frame 3: reviewed by both, drawn by neither.

        let cases = pair_cases(&conn, 1, 2, 1, FrameBasis::ReviewedByBoth).unwrap();
        assert_eq!(cases.iter().map(|c| c.frame_id).collect::<Vec<_>>(), [2, 1]);
        assert!((cases[0].dice - 0.5).abs() < 1e-9);
        assert!((cases[1].dice - 1.0).abs() < 1e-9);
        assert_eq!(cases[0].name, "s · frame 2", "a multi-frame sequence names its frame");
        assert_eq!((cases[0].pixels_a, cases[0].pixels_b), (2, 2));
    }

    const TEST_COLOURS: Colours =
        Colours { only_a: [230, 159, 0], only_b: [86, 180, 233], both: [255, 255, 255] };

    #[test]
    fn the_comparison_colours_agreement_and_each_graders_extra() {
        // 2×1 image, mid grey; grader A marked both pixels, B only the second.
        let mut rgb = vec![100u8; 6];
        draw_comparison(&mut rgb, 2, 1, Some(&[1, 1]), Some(&[0, 1]), 2, 1, &TEST_COLOURS, 0);
        let blend = |colour: [u8; 3], alpha: f32| -> Vec<u8> {
            colour.iter().map(|c| (100.0 * (1.0 - alpha) + *c as f32 * alpha).round() as u8).collect()
        };
        assert_eq!(&rgb[0..3], blend(TEST_COLOURS.only_a, ALPHA_ONLY).as_slice());
        assert_eq!(&rgb[3..6], blend(TEST_COLOURS.both, ALPHA_BOTH).as_slice());
    }

    #[test]
    fn colours_are_read_from_hex_and_bad_ones_refused() {
        assert_eq!(parse_hex("#E69F00"), Ok([230, 159, 0]));
        assert_eq!(parse_hex("56b4e9"), Ok([86, 180, 233]));
        assert!(parse_hex("#fff").is_err());
        assert!(parse_hex("#zzzzzz").is_err());
        assert!(parse_hex("#ééé").is_err(), "non-ASCII must not panic on slicing");
    }

    /// Which pixels of a `size×size` black image got drawn on.
    fn drawn(rgb: &[u8]) -> Vec<bool> {
        rgb.chunks_exact(3).map(|p| p != [0, 0, 0]).collect()
    }

    #[test]
    fn edge_mode_draws_the_outline_and_leaves_the_inside_clear() {
        // A 5×5 square in the middle of a 7×7 frame.
        let mut mask = [0u8; 49];
        for y in 1..6 {
            for x in 1..6 {
                mask[y * 7 + x] = 1;
            }
        }
        let mut rgb = vec![0u8; 49 * 3];
        draw_comparison(&mut rgb, 7, 7, Some(&mask), None, 7, 7, &TEST_COLOURS, 1);
        let on = drawn(&rgb);
        assert!(on[1 * 7 + 1] && on[1 * 7 + 3] && on[3 * 7 + 5], "the border ring is drawn");
        assert!(!on[3 * 7 + 3] && !on[2 * 7 + 2], "the inside is not");
        assert!(!on[0], "nor the outside");
        assert_eq!(on.iter().filter(|v| **v).count(), 16, "a one-pixel ring around 5×5");
        assert_eq!(&rgb[(7 + 1) * 3..(7 + 1) * 3 + 3], TEST_COLOURS.only_a, "opaque");

        // Twice as thick: only the centre pixel stays clear.
        let mut rgb = vec![0u8; 49 * 3];
        draw_comparison(&mut rgb, 7, 7, Some(&mask), None, 7, 7, &TEST_COLOURS, 2);
        assert_eq!(drawn(&rgb).iter().filter(|v| **v).count(), 24);
    }

    #[test]
    fn a_region_running_off_the_frame_is_not_outlined_along_the_frame() {
        // The whole left half of a 6×6 frame.
        let mut mask = [0u8; 36];
        for y in 0..6 {
            for x in 0..3 {
                mask[y * 6 + x] = 1;
            }
        }
        let mut rgb = vec![0u8; 36 * 3];
        draw_comparison(&mut rgb, 6, 6, Some(&mask), None, 6, 6, &TEST_COLOURS, 1);
        let on = drawn(&rgb);
        for y in 0..6 {
            assert!(on[y * 6 + 2], "the real boundary, at x = 2");
            assert!(!on[y * 6], "not the picture's own edge");
        }
    }

    #[test]
    fn coinciding_outlines_take_the_shared_colour() {
        // Both graders drew the same 3×3 square: every outline pixel is shared.
        let mut frame = [0u8; 25];
        for y in 1..4 {
            for x in 1..4 {
                frame[y * 5 + x] = 1;
            }
        }
        let mut rgb = vec![0u8; 25 * 3];
        draw_comparison(&mut rgb, 5, 5, Some(&frame), Some(&frame), 5, 5, &TEST_COLOURS, 1);
        assert_eq!(&rgb[(5 + 1) * 3..(5 + 1) * 3 + 3], TEST_COLOURS.both);
        assert_eq!(&rgb[(2 * 5 + 2) * 3..(2 * 5 + 2) * 3 + 3], [0, 0, 0]);
    }

    #[test]
    fn a_thin_structure_survives_being_drawn_small() {
        // An 8×1 image previewed at 2×1: a single marked pixel at x = 5 must
        // still mark the preview pixel covering it.
        let mut rgb = vec![0u8; 6];
        let mut mask = [0u8; 8];
        mask[5] = 1;
        draw_comparison(&mut rgb, 2, 1, Some(&mask), None, 8, 1, &TEST_COLOURS, 0);
        assert_eq!(&rgb[0..3], [0, 0, 0]);
        assert_ne!(&rgb[3..6], [0, 0, 0]);
    }

    /// The hatching bug: drawn larger than the frame, a solid region came out
    /// striped, because only one preview pixel per native pixel was marked.
    #[test]
    fn a_solid_region_stays_solid_when_drawn_larger_than_the_frame() {
        // A fully marked 2×2 frame drawn at 5×5.
        let mut rgb = vec![0u8; 5 * 5 * 3];
        draw_comparison(&mut rgb, 5, 5, Some(&[1, 1, 1, 1]), None, 2, 2, &TEST_COLOURS, 0);
        assert!(
            rgb.chunks_exact(3).all(|pixel| pixel != [0, 0, 0]),
            "every preview pixel lies over a marked native pixel"
        );
    }

    #[test]
    fn a_grader_who_did_nothing_does_not_empty_the_common_frames() {
        let conn = project();
        conn.execute("INSERT INTO users (id, name) VALUES (3, 'Idle')", []).unwrap();
        review(&conn, 1, &[1]);
        review(&conn, 2, &[1]);
        let report = build_report(&conn, FrameBasis::ReviewedByBoth).unwrap();
        assert_eq!(report.frames_common_to_all, 1);
        assert_eq!(report.pairs.len(), 3, "the idle grader still appears, with nothing to compare");
    }
}
